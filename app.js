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
$("btn-signout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    viewLogin.classList.add("hidden");
    viewApp.classList.remove("hidden");
    await loadDeck(currentDeck);
  } else {
    viewLogin.classList.remove("hidden");
    viewApp.classList.add("hidden");
  }
});

// --- デッキ切り替え ---
document.querySelectorAll(".deck-tab").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".deck-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentDeck = btn.dataset.deck;
    updateAddFormLabels();
    await loadDeck(currentDeck);
  });
});

function updateAddFormLabels() {
  const isVocab = currentDeck === "vocab";
  $("add-heading").textContent = isVocab ? "語彙カードを追加" : "病態カードを追加";
  $("label-front").textContent = isVocab ? "英単語・フレーズ" : "疾患名・トピック";
  $("label-back").textContent = isVocab ? "意味・メモ" : "フレームワーク・メモ";
  document.querySelectorAll(".vocab-only").forEach((el) => {
    el.classList.toggle("hidden", !isVocab);
  });
}

// --- Firestore アクセス ---
function cardsCol() {
  return collection(db, "users", currentUser.uid, "cards");
}

async function loadDeck(deck) {
  if (!currentUser) return;
  const q = query(cardsCol(), where("deck", "==", deck));
  const snap = await getDocs(q);
  allCards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderHome();
  renderBrowse();
}

async function saveCard(data) {
  await addDoc(cardsCol(), {
    ...data,
    deck: currentDeck,
    srs: { ...DEFAULT_SRS },
    createdAt: serverTimestamp()
  });
  await loadDeck(currentDeck);
}

async function updateCardSrs(cardId, srs) {
  await updateDoc(doc(db, "users", currentUser.uid, "cards", cardId), { srs });
}

async function deleteCard(cardId) {
  await deleteDoc(doc(db, "users", currentUser.uid, "cards", cardId));
  await loadDeck(currentDeck);
}

// --- 画像（圧縮してFirestoreに直接保存） ---
let pendingImage = null;

function fileToResizedBase64(file, maxDim = 1000, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$("input-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingImage = await fileToResizedBase64(file);
  if (pendingImage.length > 900000) {
    showToast("画像が大きすぎます。別の画像を選んでください");
    pendingImage = null;
    e.target.value = "";
    $("image-preview").classList.add("hidden");
    return;
  }
  $("image-preview").src = pendingImage;
  $("image-preview").classList.remove("hidden");
});

// --- カード追加フォーム ---
$("form-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const front = $("input-front").value.trim();
  const back = $("input-back").value.trim();
  const example = $("input-example").value.trim();
  const tags = $("input-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  if (!front || !back) return;

  await saveCard({ front, back, example, tags, ...(pendingImage ? { image: pendingImage } : {}) });
  $("form-add").reset();
  pendingImage = null;
  $("image-preview").classList.add("hidden");
  showToast("カードを保存しました");
  switchPane("home");
});

// --- ホーム ---
function renderHome() {
  const due = allCards.filter((c) => c.srs.due <= todayStr());
  const fresh = allCards.filter((c) => c.srs.repetition === 0);
  $("due-count").textContent = due.length;
  $("stat-total").textContent = allCards.length;
  $("stat-new").textContent = fresh.length;
}

$("btn-start-review").addEventListener("click", startReview);
$("btn-review-back").addEventListener("click", () => switchPane("home"));

// --- 復習セッション ---
function startReview() {
  reviewQueue = allCards
    .filter((c) => c.srs.due <= todayStr())
    .sort((a, b) => (a.srs.due < b.srs.due ? -1 : 1));
  reviewIndex = 0;
  switchPane("review");
  showReviewCard();
}

function showReviewCard() {
  const empty = $("review-empty");
  const area = $("review-card-area");
  if (reviewIndex >= reviewQueue.length) {
    empty.classList.remove("hidden");
    area.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  area.classList.remove("hidden");

  const card = reviewQueue[reviewIndex];
  $("review-progress-text").textContent = `${reviewIndex + 1} / ${reviewQueue.length}`;
  $("card-front").textContent = card.front;
  $("card-example").textContent = card.example || "";
  if (card.image) {
    $("card-image").src = card.image;
    $("card-image").classList.remove("hidden");
  } else {
    $("card-image").classList.add("hidden");
  }
  $("card-back").textContent = card.back;
  $("card-back").classList.add("hidden");
  $("btn-reveal").classList.remove("hidden");
  $("grade-buttons").classList.add("hidden");
}

$("btn-reveal").addEventListener("click", () => {
  $("card-back").classList.remove("hidden");
  $("btn-reveal").classList.add("hidden");
  $("grade-buttons").classList.remove("hidden");
});

document.querySelectorAll(".btn-grade").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const card = reviewQueue[reviewIndex];
    const newSrs = sm2(card.srs, btn.dataset.grade);
    card.srs = newSrs;
    await updateCardSrs(card.id, newSrs);
    reviewIndex += 1;
    showReviewCard();
    renderHome();
  });
});

// --- 一覧 / 検索 / 編集 / 削除 ---
$("browse-search").addEventListener("input", renderBrowse);

function renderBrowse() {
  const term = $("browse-search").value.trim().toLowerCase();
  const list = $("browse-list");
  list.innerHTML = "";
  allCards
    .filter((c) => !term || c.front.toLowerCase().includes(term) || c.back.toLowerCase().includes(term))
    .sort((a, b) => (a.front > b.front ? 1 : -1))
    .forEach((c) => {
      const li = document.createElement("li");
      li.className = "browse-item";
      li.innerHTML = `
        <div class="browse-item-front"></div>
        <img class="browse-item-thumb hidden">
        <div class="browse-item-back"></div>
        <div class="browse-item-meta">
          <span class="browse-item-due"></span>
          <span class="browse-item-actions"><button data-act="delete">削除</button></span>
        </div>`;
      li.querySelector(".browse-item-front").textContent = c.front;
      if (c.image) {
        const thumb = li.querySelector(".browse-item-thumb");
        thumb.src = c.image;
        thumb.classList.remove("hidden");
      }
      li.querySelector(".browse-item-back").textContent = c.back;
      li.querySelector(".browse-item-due").textContent = `次回: ${c.srs.due}`;
      li.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        if (confirm(`「${c.front}」を削除しますか？`)) {
          await deleteCard(c.id);
          showToast("削除しました");
        }
      });
      list.appendChild(li);
    });
}

// --- エクスポート / インポート ---
$("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(allCards, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `amc-${currentDeck}-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("input-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let items;
  try { items = JSON.parse(text); } catch { showToast("JSONの読み込みに失敗しました"); return; }
  for (const item of items) {
    await addDoc(cardsCol(), {
      front: item.front, back: item.back, example: item.example || "",
      tags: item.tags || [], deck: currentDeck,
      srs: item.srs || { ...DEFAULT_SRS },
      createdAt: serverTimestamp()
    });
  }
  await loadDeck(currentDeck);
  showToast(`${items.length}件をインポートしました`);
  e.target.value = "";
});

// --- ペイン / ナビゲーション ---
function switchPane(name) {
  document.querySelectorAll(".pane").forEach((p) => p.classList.add("hidden"));
  $(`pane-${name}`).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.pane === "review") startReview();
    else switchPane(btn.dataset.pane);
  });
});

updateAddFormLabels();
