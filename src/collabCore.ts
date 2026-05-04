import {
  CRDTDocument,
  type TextPatch,
  type TransferOp,
  type RemoteVersion,
  type FullSyncOplog,
} from "./egwalker.js";

export type LocalChange = {
  from: number;
  to: number;
  insert: string;
};

//리스너 타입 정의 (관찰자 패턴)
type PatchListener = (patches: TextPatch[]) => void;  // 외부 변경 시(실시간)
type ReplaceListener = (text: string) => void         // 외부 변경 시(전체 1회)
type DebugListener = (text: string) => void;          // 디버그 정보 업데이트 시
type LocalEditListener = () => void;                  // 로컬 변경 시

// 문서 상태와 동기화 담당
export class CollabCore {
  name: string;
  doc: CRDTDocument;

  // 각 에디터 화면마다 독립적인 리스너 필요
  // -> Set으로 관리하면 중복 없음 + 연결 해제 쉬움
  private patchListeners = new Set<PatchListener>();
  private replaceListeners = new Set<ReplaceListener>()
  private debugListeners = new Set<DebugListener>();
  private localEditListeners = new Set<LocalEditListener>();

  constructor(name: string) {
    this.name = name;
    this.doc = new CRDTDocument(name);
  }

  //로컬 입력 적용
  applyLocalChange(change: LocalChange) {
    const delLen = change.to - change.from;

    // 삭제 
    if (delLen > 0) {
      this.doc.del(change.from, delLen);
    }
    // 삽입
    if (change.insert.length > 0) {
      this.doc.ins(change.from, change.insert);
    }
    // dellen 없이 아래 조건만으로 삽입 삭제 구분 가능하지 않음?
    // -> 한글 중간 글자 (ㅁ -> 마: ㅁ마) 나 글자 교체시 인식 못함. 그래서 조건 분리

    // 디버깅용
    // this.doc.check()

    // 상태 변경 알림
    this.emitLocalEdit();
    this.emitDebug();
  }


  // 문서 초기화
  reset() {
    const oldLength = this.doc.getString().length;
    this.doc = new CRDTDocument(this.name);

    this.emitReplace("");
    this.emitDebug();
  }

  getText() {
    return this.doc.getString();
  }

  getVersion(): RemoteVersion {
    return this.doc.getVersion();
  }

  getMissingOps(remoteVersion: RemoteVersion): TransferOp<string>[] {
    return this.doc.getMissingOps(remoteVersion);
  }

  applyDelta(deltaOps: TransferOp<string>[]) {
    if (deltaOps.length === 0) return;

    const patches = this.doc.mergeDelta(deltaOps);

    if (patches.length > 0) {
      this.emitPatches(patches);
    }

    this.emitDebug();
  }

  exportOplog(): FullSyncOplog<string> {
    return this.doc.exportOplog();
  }

  applyFullSync(oplog: FullSyncOplog<string>) {
    // 내부적으로는 merge
    this.doc.applyFullSync(oplog);

    // UI는 최종 결과로 강제 정렬
    this.emitReplace(this.doc.getString());
    this.emitDebug();
  }

  //원격 연산 리스너 연결 및 반환
  onRemotePatches(listener: PatchListener) {
    this.patchListeners.add(listener); //리스너 연결 (리스너가 자동 동기화)
    return () => this.patchListeners.delete(listener); //나중에 ()로 함수 호출시 연결 해제
  }

  onReplaceText(listener: ReplaceListener) {
    this.replaceListeners.add(listener)
    return () => this.replaceListeners.delete(listener)
  }

  //디버그 리스너 연결 및 반환
  onDebugText(listener: DebugListener) {
    this.debugListeners.add(listener);
    listener(this.getDebugText());// 디버그 상태 출력
    return () => this.debugListeners.delete(listener);
  }

  //로컬 연산 리스너 연결 및 반환
  onLocalEdit(listener: LocalEditListener) {
    this.localEditListeners.add(listener);
    return () => this.localEditListeners.delete(listener);
  }

  private emitPatches(patches: TextPatch[]) {
    for (const listener of this.patchListeners) {
      listener(patches);
    }
  }

  private emitReplace(text: string) {
    for (const listener of this.replaceListeners) {
      listener(text)
    }
  }

  private emitDebug() {
    const text = this.getDebugText();
    for (const listener of this.debugListeners) {
      listener(text);
    }
  }

  private emitLocalEdit() {
    for (const listener of this.localEditListeners) {
      listener();
    }
  }

  // //디버깅용: Oplog를 읽기 쉬운 문자열로 변환
  // private formatOps() {
  //   return this.doc.oplog.ops
  //     .map((op: any, i: number) => {
  //       if (!op) return `[${i}] <empty>`;

  //       const id = Array.isArray(op.id)
  //         ? `${op.id[0]}:${op.id[1]}`
  //         : String(op.id);

  //       const parents = JSON.stringify(op.parents ?? []);

  //       if (op.type === "ins") {
  //         return `[${i}] ins id=${id} pos=${op.pos} text=${JSON.stringify(op.content)} parents=${parents}`;
  //       }

  //       if (op.type === "del") {
  //         return `[${i}] del id=${id} pos=${op.pos} parents=${parents}`;
  //       }

  //       return `[${i}] ${JSON.stringify(op)}`;
  //     })
  //     .join("\n");
  // }

  // getDebugText() {
  //   return (
  //     `[${this.name}]\n` +
  //     `text: ${this.doc.getString()}\n` +
  //     `frontier: ${JSON.stringify(this.doc.oplog.frontier)}\n\n` +
  //     this.formatOps()
  //   );
  // }
private previewText(text: string, maxLen = 300) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + ` ... [${text.length - maxLen} chars omitted]`;
}

// 디버깅용: 최근 N개 op만 읽기 쉬운 문자열로 변환
private formatOps(limit = 50) {
  const ops = this.doc.oplog.ops;
  const start = Math.max(0, ops.length - limit);

  return ops
    .slice(start)
    .map((op: any, offset: number) => {
      const i = start + offset;

      if (!op) return `[${i}] <empty>`;

      const id = Array.isArray(op.id)
        ? `${op.id[0]}:${op.id[1]}`
        : String(op.id);

      const parents = JSON.stringify(op.parents ?? []);

      if (op.type === "ins") {
        return `[${i}] ins id=${id} pos=${op.pos} text=${JSON.stringify(op.content)} parents=${parents}`;
      }

      if (op.type === "del") {
        return `[${i}] del id=${id} pos=${op.pos} parents=${parents}`;
      }

      return `[${i}] ${JSON.stringify(op)}`;
    })
    .join("\n");
}

getDebugText() {
  const text = this.doc.getString();
  const totalOps = this.doc.oplog.ops.length;
  const shownOps = Math.min(50, totalOps);

  return (
    `[${this.name}]\n` +
    `textLength: ${text.length}\n` +
    `textPreview: ${JSON.stringify(this.previewText(text))}\n` +
    `frontier: ${JSON.stringify(this.doc.oplog.frontier)}\n` +
    `opsTotal: ${totalOps}\n` +
    `showingLast: ${shownOps}\n\n` +
    this.formatOps(50)
  );
}
}
