import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, updateDoc, deleteDoc, getDocs,
  query, where, serverTimestamp, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
try { enableIndexedDbPersistence(db); } catch (e) { /* 複数タブ等では無効化される場合がある */ }

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function sm2(srs, grade) {
  let { ef, interval, repetition } = srs;
  const quality = { hard: 2, good: 4, easy: 5 }[grade];
  if (quality < 3) {
    repetition = 0;
    interval = 1;
  } else {
    if (repetition === 0) interval = 1;
    else if (repetition === 1) interval = 6;
    else interval = Math.round(interval * ef);
    repetition += 1;
  }
  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;
  return { ef, interval, repetition, due: addDays(interval) };
}

const DEFAULT_SRS = { ef: 2.5, interval: 0, repetition: 0, due: todayStr() };

// --- 状態 ---
let currentUser = null;
let currentDeck = "vocab";
let allCards = [];          // 現在のデッキの全カード（キャッシュ）
let reviewQueue = [];
let reviewIndex = 0;

// --- DOM ---
const $ = (id) => document.getElementById(id);
const viewLogin = $("view-login");
const viewApp = $("view-app");

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 1800);
}

// --- 認証 ---
$("btn-signin").addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
    console.error(e);
    showToast("サインインに失敗しました");
  });
});
