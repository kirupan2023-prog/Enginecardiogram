import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue } from "firebase/database";

// Firebase Realtime Database configuration
const firebaseConfig = {
  apiKey: "AIzaSyCP6LrjDzfoGQZ4rEo43whsb4jlG0antxA",
  authDomain: "enginecardiogram.firebaseapp.com",
  databaseURL: "https://enginecardiogram-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "enginecardiogram",
  storageBucket: "enginecardiogram.firebasestorage.app",
  messagingSenderId: "179768917030",
  appId: "1:179768917030:web:ac85361d89ebed1077bae7",
  measurementId: "G-D5LQTPG6CQ"
};

let app = null;
let db = null;

try {
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
} catch (err) {
  console.warn('[Firebase] Safe initialization notice (app will run locally):', err);
}

export { db, ref, set, onValue };