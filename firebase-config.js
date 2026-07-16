// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDZQg2jNxdbaKWLxHAxh4rzz-IUp35BbBk",
  authDomain: "movietogether-88b89.firebaseapp.com",
  databaseURL: "https://movietogether-88b89-default-rtdb.firebaseio.com",
  projectId: "movietogether-88b89",
  storageBucket: "movietogether-88b89.firebasestorage.app",
  messagingSenderId: "996110514025",
  appId: "1:996110514025:web:24184ce9992a3a5ffaaff8",
  measurementId: "G-R6GYV9Z1JZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);