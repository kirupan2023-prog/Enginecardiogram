import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue } from "firebase/database";

// Replace these with your actual Firebase project keys from Step 1
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

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export { ref, set, onValue };