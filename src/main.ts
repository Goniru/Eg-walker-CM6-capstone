import "./style.css"
import { CollabCore } from "./collabCore.js"
import { CodeMirrorBinding } from "./editorBinding.js"
import type { CompressedTransferOp, FullSyncOplog, RemoteVersion, TransferOp } from "./egwalker.js"
import { compressTransferOps, deCompressTransferOps } from "./egwalker.js"

type Msg =
  | { type: "hello"; room: string; id: string }
  | { type: "request-full-sync"; room: string; id: string }
  | { type: "full-sync"; room: string; id: string; to: string; oplog: FullSyncOplog<string> }
  | { type: "announce-version"; room: string; id: string; version: RemoteVersion }
  | { type: "request-delta"; room: string; id: string; to: string; version: RemoteVersion }
  | { type: "delta"; room: string; id: string; to: string; runs: CompressedTransferOp<string>[] }
  | { type: "reset"; room: string; id: string }

const params = new URLSearchParams(location.search)
const room = params.get("room") ?? "test"
const id = params.get("id") ?? crypto.randomUUID().slice(0, 8)

const app = document.getElementById("app")!

app.innerHTML = `
  <div class="page">
    <section class="pane">
      <div id="editor" class="editor"></div>
      <pre id="oplog" class="oplog"></pre>
    </section>

    <aside class="control-panel">
      <button id="bt-reset">reset</button>
      <button id="bt-full-sync">request full sync</button>
      <button id="bt-sync">sync: ON</button>
      <div>room: ${room}</div>
      <div>id: ${id}</div>
    </aside>
  </div>
`

const parent = document.getElementById("editor")!
const oplogEl = document.getElementById("oplog")!

let syncEnabled = false;
const btSync = document.getElementById("bt-sync")!;

function updateSyncButton() {
  btSync.textContent = syncEnabled ? "sync: ON" : "sync: OFF";
}

updateSyncButton();

const core = new CollabCore(id)
new CodeMirrorBinding(core, parent)

core.onDebugText((text) => {
  oplogEl.textContent = text
})

const ws = new WebSocket("ws://localhost:8787")

function send(msg: Msg) {
  ws.send(JSON.stringify(msg))
}

ws.addEventListener("open", () => {
  send({ type: "hello", room, id })
  send({ type: "request-full-sync", room, id })
})

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data) as Msg

  if (msg.id === id) return
  if (msg.room !== room) return

  switch (msg.type) {
    case "request-full-sync": {
      // 수동 full sync는 syncEnabled와 무관하게 항상 허용
      send({
        type: "full-sync",
        room,
        id,
        to: msg.id,
        oplog: core.exportOplog(),
      })
      break
    }

    case "full-sync": {
      // 수동 full sync는 syncEnabled와 무관하게 항상 허용
      if (msg.to !== id) return
      core.applyFullSync(msg.oplog)
      break
    }

    case "announce-version": {
      // 자동 동기화는 OFF면 무시
      if (!syncEnabled) return

      send({
        type: "request-delta",
        room,
        id,
        to: msg.id,
        version: core.getVersion(),
      })
      break
    }

    case "request-delta": {
      // 자동 동기화는 OFF면 무시
      if (!syncEnabled) return
      if (msg.to !== id) return

      const missingOps = core.getMissingOps(msg.version)
        const runs = compressTransferOps(missingOps)

        // console.log("[delta send]", {
        //     rawOps: missingOps.length,
        //     run: runs.length, 
        //     runs,
        // })

      send({
        type: "delta",
        room,
        id,
        to: msg.id,
        runs,
      })
      break
    }

    case "delta": {
      // 자동 동기화는 OFF면 무시
      if (!syncEnabled) return
      if (msg.to !== id) return

      try {
        const ops = deCompressTransferOps(msg.runs)

        // console.log("[delta recv]", {
        // runs: msg.runs.length,
        // expandedOps: ops.length,
        // })

        core.applyDelta(ops)
      } catch (err) {
        console.error("delta apply failed, fallback to full sync", err)
        send({ type: "request-full-sync", room, id })
      }

      break
    }

  }
})

core.onLocalEdit(() => {
  if (!syncEnabled) return;
  if (ws.readyState !== WebSocket.OPEN) return

  send({
    type: "announce-version",
    room,
    id,
    version: core.getVersion(),
  })
})

document.getElementById("bt-reset")!.addEventListener("click", () => {
  syncEnabled = false
  updateSyncButton()

  core.reset()
})

document.getElementById("bt-full-sync")!.addEventListener("click", () => {
  send({ type: "request-full-sync", room, id })
})


btSync.addEventListener("click", () => {
  syncEnabled = !syncEnabled;
  updateSyncButton();

  if (syncEnabled && ws.readyState === WebSocket.OPEN) {
    // 1) 상대 전체 oplog를 받아와 merge
    send({ type: "request-full-sync", room, id });

    // 2) 내 현재 version도 알림
    send({
      type: "announce-version",
      room,
      id,
      version: core.getVersion(),
    });
  }
});