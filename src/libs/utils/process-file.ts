import CompressWorker from "./process-file-worker?worker";
import { catchError, catchErrorSync } from "@/libs/catch";

export type FileWithPath = {
  file?: File;
  fullPath?: string;
};

export type FilesMap = {
  // Directory key is directory name
  directories: Record<string, FileWithPath[]>;
  // File
  files: File[];
};

export const handleSelectFolder = async (
  files: FileList,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  return new Promise<File>(async (resolve, reject) => {
    signal?.addEventListener("abort", () =>
      reject(new Error(signal?.reason)),
    );
    const fileEntries = Array.from(files).map((file) => ({
      file,
      fullPath: file.webkitRelativePath,
    }));

    let processedFiles: File | undefined;

    const folderName = getFolderName(fileEntries);
    let error: Error | undefined = undefined;
    [error, processedFiles] = await catchError(
      processFiles(fileEntries, folderName, signal),
    );
    if (error) return reject(error);

    [error] = catchErrorSync(() =>
      signal?.throwIfAborted(),
    );
    if (error) return reject(error);

    resolve(processedFiles!);
  });
};

export const handleDropItems = async (
  items: DataTransferItemList,
  signal?: AbortSignal,
): Promise<File[]> => {
  signal?.throwIfAborted();
  return new Promise<File[]>(async (resolve, reject) => {
    signal?.addEventListener("abort", () =>
      reject(new Error(signal?.reason)),
    );
    const entries: FileSystemEntry[] = [];
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.webkitGetAsEntry();

      if (entry) {
        entries.push(entry);
        continue;
      }

      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
    if (entries.length > 0) {
      const filesMap: FilesMap = {
        directories: {},
        files: [],
      };

      let error: Error | undefined = undefined;
      [error] = await catchError(
        Promise.all(
          entries.map((entry) =>
            readEntry(entry, filesMap, undefined, signal),
          ),
        ),
      );
      if (error) return reject(error);

      let compressedFoldersResult:
        | (File | null)[]
        | undefined;
      [error, compressedFoldersResult] = await catchError(
        Promise.all(
          Object.entries(filesMap.directories).map(
            async ([folderName, files]) =>
              await processFiles(files, folderName, signal),
          ),
        ),
      );
      if (error) return reject(error);

      const compressedFolders =
        compressedFoldersResult!.filter(Boolean) as File[];

      files.push(...filesMap.files, ...compressedFolders);
    }
    resolve(files);
  });
};

function readEntry(
  entry: FileSystemEntry,
  map: FilesMap,
  folderName?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      fileEntry.file(
        (f: File) => {
          if (folderName) {
            map.directories[folderName].push({
              file: f,
              fullPath: entry.fullPath.substring(1),
            });
          } else {
            map.files.push(f);
          }
          resolve();
        },
        (err) => reject(err),
      );
    } else if (entry.isDirectory) {
      const dirReader = (
        entry as FileSystemDirectoryEntry
      ).createReader();
      const folderName = entry.fullPath?.split("/")[1];
      if (!map.directories[folderName]) {
        map.directories[folderName] = [];
      }

      const readEntries = () => {
        dirReader.readEntries(async (entries) => {
          if (entries.length === 0) {
            if (folderName) {
              map.directories[folderName].push({
                fullPath: entry.fullPath.substring(1),
              });
            }
            resolve();
            return;
          }

          const [error] = await catchError(
            Promise.all(
              entries.map((entry) =>
                readEntry(entry, map, folderName, signal),
              ),
            ),
          );
          if (error) return reject(error);

          return readEntries();
        });
      };
      readEntries();
    }
  });
}

function getFolderName(fileEntries: FileWithPath[]) {
  if (!fileEntries.length) return Date.now().toString();
  const firstPath = fileEntries[0].fullPath;
  if (!firstPath) return Date.now().toString();
  const parts = firstPath.split("/");
  return parts.length > 1
    ? parts[0]
    : Date.now().toString();
}

/**
 * Process files and return a compressed file
 * @param files - Array of files to process
 * @param folderName - Name of the folder to compress
 * @param abortController - Abort controller to abort the process
 * @returns Compressed file
 */
async function processFiles(
  files: FileWithPath[],
  folderName: string,
  signal?: AbortSignal,
): Promise<File> {
  const fileMap: Record<string, File | null> = {};

  files.map((file) => {
    // If file is not a file, it's a directory
    if (!file.file) {
      // Empty directory
      if (file.fullPath) fileMap[file.fullPath] = null;
      return;
    }

    const fullPath = file.fullPath ?? file.file.name;
    fileMap[fullPath] = file.file;
  });

  return await compressFiles(fileMap, folderName, signal);
}

async function compressFiles(
  fileMap: Record<string, File | null>,
  folderName: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const worker = new CompressWorker();
  return new Promise<File>((resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error(signal?.reason));
    });
    worker.onmessage = (event) => {
      const result = event.data;
      if (result.error) return reject(result.error);
      resolve(result.data);
    };
    worker.postMessage({ fileMap, folderName });
  }).finally(() => {
    worker.terminate();
  });
}
