import { WebSocketServer } from "ws";

console.log("[relay] starting...");

const wss = new WebSocketServer({ port: 8787 });

wss.on("listening", () => {
  console.log("[relay] listening on ws://127.0.0.1:8787");
});

wss.on("connection", () => {
  console.log("[relay] client connected");
});

wss.on("error", (err) => {
  console.error("[relay] server error:", err);
});

type ExtWs = import("ws").WebSocket & {
  room?: string;
  id?: string;
};

wss.on("connection", (ws: ExtWs) => {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "hello") {
      ws.room = msg.room;
      ws.id = msg.id;
      console.log(`[relay] hello room=${ws.room} id=${ws.id}`);
    }

    for (const client of wss.clients) {
      const peer = client as ExtWs;

      if (peer === ws) continue;
      if (peer.readyState !== 1) continue;
      if (peer.room !== ws.room) continue;

      peer.send(JSON.stringify(msg));
    }
  });
});