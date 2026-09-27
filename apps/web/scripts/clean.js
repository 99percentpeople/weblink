import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const foldersToDelete = ["node_modules", "dist"];

foldersToDelete.forEach(folder => {
  const folderPath = path.join(process.cwd(), folder);
  if (fs.existsSync(folderPath)) {
    if (process.platform === "win32") {
      execSync(`rmdir /s /q "${folderPath}"`);
    } else {
      execSync(`rm -rf "${folderPath}"`);
    }
    console.log(`Deleted ${folder} folder.`);
  } else {
    console.log(`${folder} folder not found.`);
  }
});

