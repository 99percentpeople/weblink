// Import the functions you need from the SDKs you need
import { FirebaseApp, initializeApp } from "firebase/app";
import { Database, getDatabase } from "firebase/database";

let db: Database | undefined;
let app: FirebaseApp | undefined;

if (import.meta.env.VITE_BACKEND === "FIREBASE") {
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env
      .VITE_FIREBASE_SOTRAGE_BUCKET,
    messagingSenderId: import.meta.env
      .VITE_FIREBASE_MESSAGEING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env
      .VITE_FIREBASE_MEASUREMENT_ID,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  };

  // Initialize Firebase
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
}

export { db, app };
