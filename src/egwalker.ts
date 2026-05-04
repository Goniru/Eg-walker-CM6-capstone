import FastPriorityQueue from "fastpriorityqueue"

export type TextPatch = { type: "insert"; pos: number; text: string }
  | { type: "delete"; pos: number; length: number }

type PatchSink = {
  insert(pos: number, text: string): void
  delete(pos: number, length: number): void
}

// 패치 압축
function compactPatches(patches: TextPatch[]): TextPatch[] {
  if (patches.length < 2) return patches

//   console.groupCollapsed("[compactPatches] start")
//   console.log("before:", structuredClone(patches))

  const out: TextPatch[] = []

  for (const p of patches) {
    const last = out[out.length - 1]

    if (!last) {
      out.push({...p} as TextPatch)
      continue
    }

    // 삽입이고 삽입 위치가 연속이면 연산 합치기
    if (last.type === 'insert' && p.type === 'insert') {
      if (last.pos + last.text.length === p.pos) {
        // console.log("merge insert", { last: structuredClone(last), next: p })
        last.text += p.text
        continue
      }
    }
    // 삭제고 삭제 위치가 연속이면 연산 합치기
    if (last.type === 'delete' && p.type === 'delete') {
      if (last.pos === p.pos) {
        // console.log("merge delete", { last: structuredClone(last), next: p })
        last.length += p.length
        continue
      }
    }

    out.push({...p} as TextPatch)
  }

//   console.log("after:", out)
//   console.log("compressed:", patches.length, "->", out.length)
//   console.groupEnd()

  return out
}



export type Id = [agent: string, seq: number] //GUID

type LV = number //local version, 몇 번째 연산인지 나타냄, ops의 인덱스로도 사용

type OpInner<T> = {
    type: 'ins',
    content: T,
    pos: number,
} | { //연산은 삽입 혹은 삭제, 삭제는 content 필요 없음
    type: 'del',
    pos: number,
}
// 메타데이터 따로 빼서 붙임 (typescript intersaction type)
type Op<T> = OpInner<T> & {
    id: Id,
    parents: LV[],
}

////////////////////
// 네트워크 전송용 자료구조: 로컬 인덱스인 parents(LV) 대신 글로벌 parentIds(Id[])를 사용
export type TransferOp<T> = OpInner<T> & {
    id: Id;
    parentIds: Id[]; // LV[] 아님
}

export type CompressedTransferOp<T> =
    | {
      kind: "ins";
      agent: string;
      seqStart: number;
      pos: number;
      text: string;
      parentIds: Id[];
    }
    | {
      kind: "del";
      agent: string;
      seqStart: number;
      pos: number;
      length: number;
      parentIds: Id[];
    };

export function compressTransferOps(ops: TransferOp<string>[]): CompressedTransferOp<string>[] {
  const out: CompressedTransferOp<string>[] = [];
  let i = 0;

  while (i < ops.length) {
    const op = ops[i];
    const [agent, seqStart] = op.id;

    if (op.type === "ins") {
      let text = op.content;
      let prevId: Id = op.id;
      let nextSeq = seqStart + 1;
      let nextPos = op.pos + 1;
      let j = i + 1;

      while (j < ops.length) {
        const next = ops[j];

        if (next.type !== "ins") break;
        if (next.id[0] !== agent) break;
        if (next.id[1] !== nextSeq) break;
        if (next.pos !== nextPos) break;

        // 같은 로컬 change에서 문자 단위로 쪼개진 경우를 보수적으로 잡기 위한 조건
        if (next.parentIds.length !== 1) break;
        if (!idEq(next.parentIds[0], prevId)) break;

        text += next.content;
        prevId = next.id;
        nextSeq += 1;
        nextPos += 1;
        j += 1;
      }

      out.push({
        kind: "ins",
        agent,
        seqStart,
        pos: op.pos,
        text,
        parentIds: op.parentIds,
      });

      i = j;
      continue;
    }

    // delete run
    let length = 1;
    let prevId: Id = op.id;
    let nextSeq = seqStart + 1;
    let j = i + 1;

    while (j < ops.length) {
      const next = ops[j];

      if (next.type !== "del") break;
      if (next.id[0] !== agent) break;
      if (next.id[1] !== nextSeq) break;
      if (next.pos !== op.pos) break;

      if (next.parentIds.length !== 1) break;
      if (!idEq(next.parentIds[0], prevId)) break;

      length += 1;
      prevId = next.id;
      nextSeq += 1;
      j += 1;
    }

    out.push({
      kind: "del",
      agent,
      seqStart,
      pos: op.pos,
      length,
      parentIds: op.parentIds,
    });

    i = j;
  }

  return out;
}

export function deCompressTransferOps(runs: CompressedTransferOp<string>[]): TransferOp<string>[] {
  const out: TransferOp<string>[] = [];

  for (const run of runs) {
    if (run.kind === "ins") {
      const chars = [...run.text];

      for (let i = 0; i < chars.length; i++) {
        out.push({
          type: "ins",
          pos: run.pos + i,
          content: chars[i],
          id: [run.agent, run.seqStart + i],
          parentIds: i === 0
            ? run.parentIds
            : [[run.agent, run.seqStart + i - 1]],
        });
      }

      continue;
    }

    for (let i = 0; i < run.length; i++) {
      out.push({
        type: "del",
        pos: run.pos,
        id: [run.agent, run.seqStart + i],
        parentIds: i === 0
          ? run.parentIds
          : [[run.agent, run.seqStart + i - 1]],
      });
    }
  }

  return out;
}

export type FullSyncOp<T> = OpInner<T> & {
    id: Id,
    parents: LV[],
}

export type FullSyncOplog<T> = {
    ops: FullSyncOp<T>[],
    frontier: LV[],
    version: RemoteVersion,
}
////////////////////

export type RemoteVersion = Record<string,number>
// = {[key: string]: number}

// 모든 연산을 담을 operation log
// 제네릭으로 확장성 염두 (eg-walker는 텍스트 하나 이외에도 적용 가능)
// 추후 한 글자가 아니라 단어 하나를 자료형으로 사용해서 성능 향상 가능
type OpLog<T> = {
    ops: Op<T>[],
    frontier: LV[], //최신 노드(자식이 없는 노드)

    version: RemoteVersion
}

function createOplog<T>(): OpLog<T> {
    return {
        ops: [],
        frontier: [],
        version: {}
    }
}

function pushLocalOps<T>(oplog: OpLog<T>, agent: string, op: OpInner<T>){
    const seq = (oplog.version[agent] ?? -1) +1 //null 이면 0, 아니면 1부터 세기
    
    const lv = oplog.ops.length
    oplog.ops.push({
        ...op,
        id: [agent, seq],
        parents: oplog.frontier
    })

    // push 후 frontier, version 업데이트
    oplog.frontier = [lv]
    oplog.version[agent] = seq 
}

function localInsert<T>(oplog: OpLog<T>, agent: string, pos: number, content: T[]){
    for (const c of content){
        pushLocalOps(oplog, agent, {
            type: 'ins',
            content: c,
            pos
        })
        pos++
    }
    
} 

function localDelete<T>(oplog: OpLog<T>, agent: string, pos: number, delLen: number){
    while (delLen > 0){
        pushLocalOps(oplog, agent, {
            type: 'del',
            pos
        })
        delLen--
    }
} 


const idEq = (a: Id, b: Id): boolean => (a == b || (a[0] === b[0] && a[1] === b[1]))

// 테스트용 임시 구현이라 선형적으로 탐색함
// 실제 구현에서는 다른 방법으로 찾아야 함
function idToLV(oplog: OpLog<any>, id: Id): LV{
    const idx = oplog.ops.findIndex(op => idEq(op.id, id))
    if (idx < 0) throw Error('id를 oplog에서 찾지 못함') // findIndex는 못찾으면 -1 반환함
    return idx
}

// sort때문에 시간복잡도가 커보이지만(O(n)~O(nlogn))
// 거의 대부분의 경우 frontier는 원소가 1개이므로 정렬 시간은 별로 상관 X
const sortLVs = (frontier: LV[]): LV[] => frontier.sort((a,b) => a - b) // 오름차순 정렬

function advanceFrontier(frontier: LV[], lv: LV, parents: LV[]): LV[]{
    const f = frontier.filter(v => !parents.includes(v)) // 배열 차집합 ( frontier에서 parents에 있는거 빼기 )
    f.push(lv)
    return sortLVs(f) // 코드흐름상 advanceFrontier에 들어올 frontier는 이미 정렬되어있지만 확실히 하기 위해
}

// 원격 연산 push
function pushRemoteOp<T> (oplog: OpLog<T>, op: Op<T>, parnetIds: Id[]){
    const [agent, seq] = op.id
    const lastKnownSeq = oplog.version[agent] ?? -1
    if (lastKnownSeq >= seq) return // 이미 적용된 연산

    const lv = oplog.ops.length
    //내부(로컬)연산은 순서가 보장되지만 외부에서 온 연산은 순서가 보장되지 않기 때문에 정렬 필요
    const parents = sortLVs(parnetIds.map(id => idToLV(oplog, id)))

    oplog.ops.push({
        ...op,
        parents
    })

    //push 후 frontier, version 업데이트

    //frontier를 업데이트하려면 특별한 로직 필요
    // why? 최신 노드는 서로 인과가 없을수도 있으므로 
    // ex) frontier = [2,3] => 새 작업의 부모가 [3]이고, 버전(LV)이 4면 
    // frontier = [2,4]가 되어야 함
    // 그래서 위에 advanceFrontier 정의
    oplog.frontier = advanceFrontier(oplog.frontier, lv, parents)

    // version 2에 version 4인 경우를 push할 경우 
    // 3이 이미 적용된 취급을 받아서 3을 적용시키지 못함 (lastKnownSeq >= seq 로 조건을 사용해서)
    if (seq !== lastKnownSeq + 1) throw Error('seq 잘못됨')//eg-walker 알고리즘 자체에서 필수는 아님
    oplog.version[agent] = seq
}

// 실제 네트워크를 통해 병합하려면 oplog에서 version을 찾아 보내고, 
// 받은 쪽에서 그 version으로부터 달라진 점들을 전부 찾아서 보내고,
// 최종적으로 변경사항만 병합하는 과정이 필요함
// 임시로 하는 메모리 단계 테스트이기 때문에 해당 함수는 생략
function mergeInto<T>(dest: OpLog<T>, src: OpLog<T>){
    for (const op of src.ops){
        //lv는 '로컬' 버전이기 때문에 원격 연산을 병합하려면 id 사용해야 함
        //lv는 로컬에서 인덱스 역할을 하므로 map을 통해 그 위치에 해당하는 id의 배열로 교체
        const parnetIds = op.parents.map(lv => src.ops[lv].id)
        pushRemoteOp(dest, op, parnetIds)
    }
}

//////////////////////////////////
//  Operation log 구현 끝
//////////////////////////////////





//////////////////////////////////
//  oplog로부터 문서 생성
//////////////////////////////////


// 밑에 diff 함수를 최적화하면서 필요 x
// // 부모 버전에 있던 모든 연산 집합 반환 => 차집합 해야하기 때문
// function expandVersionToSet(oplog: OpLog<any>, frontier: LV[]): Set<LV> {
//     const set = new Set<LV>
//     const toExpand = frontier.slice() // frontier 배열 복사(frontier는 변하면 안되기 때문에)

//     while (toExpand.length > 0){
//         const lv = toExpand.pop()!
//         if(set.has(lv)) continue
        
//         set.add(lv)
//         const op = oplog.ops[lv]
//         toExpand.push( ...op.parents)
//     }
//     return set
// }

type DiffResult = { aOnly: LV[], bOnly: LV[] }

// // 부모 버전과 현재 버전의 차이를 계산하기 위한 함수 (추가된 연산 기준)
// // 부모에는 있었지만 현재 없는 연산 : 적용(advance)해야됨
// // 부모에는 없었지만 현재 있는 연산 : 적용취소(retreat) 해야됨
// function diff(oplog: OpLog<any>, a: LV[], b: LV[]): DiffResult {
//     // 일단 임시로 나쁜 성능(O(n))의 함수 구현
//     // 실제 구현에서는 최적화 필요
//     const aExpand = expandVersionToSet(oplog, a)
//     const bExpand = expandVersionToSet(oplog, b)

//     return {
//         aOnly: [...aExpand.difference(bExpand)],// 차집합
//         bOnly: [...bExpand.difference(bExpand)]
//     }
// }


// 최적화된 diff 함수
// 우선순위 큐로 구현
// 기존에는 차집합으로 두 버전의 차이를 구했음 
// -> 이는 문서의 전체를 위에서부터 탐색하기 때문에 비효율적 
// 하지만 우선순위 큐를 사용한다면 가장 최근 연산 탐색 가능 (max heap 기반)
function diff(oplog: OpLog<any>,a: LV[], b: LV[]): DiffResult {
    // 연산의 공유 상태 나타냄
    const enum DiffFlag { A, B, Shared }
    const flags = new Map<LV, DiffFlag>() // 각 lv가 어디에 속한 연산인지 구분

    //공유된 연산 수 -> 큐의 길이와 같으면 버전간 차이 없음
    let numShared = 0
    // js라이브러리 FastPriorityQueue 사용 -> V8엔진에 최적화되어 가장 빠른 우선순위 큐 
    const queue = new FastPriorityQueue<LV>(function(a, b) {return a > b;})

    // 각 lv들을 어디에 속하는지 분류 후 큐에 넣음
    function enq(v: LV, flag: DiffFlag){
        const oldFlag = flags.get(v) // v가 어디에 속한 연산인지 확인

        if (oldFlag == null) {
            queue.add(v)
            flags.set(v, flag) 
            if (flag === DiffFlag.Shared) numShared++
        }   
        // 속한곳이 다르다 == 양쪽에 같이 존재한다 == 공유됨
        else if (oldFlag !== flag && oldFlag !== DiffFlag.Shared) { 
            flags.set(v, DiffFlag.Shared)
            numShared++
        }
    }

    for (const aa of a) enq(aa, DiffFlag.A)
    for (const bb of b) enq(bb, DiffFlag.B)

    const aOnly: LV[] = [], bOnly: LV[] = []

    // 큐와 공유된 수가 같음 == 공통 조상에 도달  == 탐색 종료
    while (queue.size > numShared) {
        //큐에서 하나씩 뽑음
        const lv = queue.poll()! // undefined 주의
        const flag = flags.get(lv)!

        if (flag === DiffFlag.Shared) numShared--
        else if (flag === DiffFlag.A) aOnly.push(lv)
        else if (flag === DiffFlag.B) bOnly.push(lv)

        const op = oplog.ops[lv]
        for (const p of op.parents) enq(p, flag)
    }

    return {aOnly, bOnly}
}

//// curState
const NOT_INSERTED_YET = -1
const INSERTED = 0
// deleted(1) = 1, deleted(2) = 2, ....

type CRDTItem = {
    lv: LV,
    originLeft: LV | -1,
    originRight: LV | -1,

    deleted: boolean,

    curState: number // 위쪽의 상수들이 들어갈 예정
}

type CRDTDoc = {
    items: CRDTItem[],
    currentVersion: LV[],

    delTargets: LV[], // 어떤 걸 delete할지 알려줌
    itemsByLV: CRDTItem[] // LV => CRDTItem 
}

// 연산의 효과 취소
function retreat(doc: CRDTDoc, oplog: OpLog<any>, opLv: LV) {
    const op = oplog.ops[opLv]
    // op.pos는 왜 안씀? => 그 연산이 정의된 때와 같은 상태일때만 가능

    const targetLV = op.type === 'ins' ? opLv : doc.delTargets[opLv]

    const item = doc.itemsByLV[targetLV]
    //deleted (1) 면 inserted (0)로, 
    // inserted면 not_inserted_yet (-1)로
    item.curState-- 
}

// 연산의 효과 적용(retreat의 반대)
function advance(doc: CRDTDoc, oplog: OpLog<any>, opLv: LV) {
    const op = oplog.ops[opLv]

    const targetLV = op.type === 'ins' ? opLv : doc.delTargets[opLv]

    const item = doc.itemsByLV[targetLV]
    // retreat의 반대 
    item.curState++
}

// pos로 인덱스 접근 안하고 함수 만드는 이유
// op.pos는 연산이 실행될때 당시 문서에서의 인덱스 => 내부 CRDT 구조의 인덱스가 아님
// End pos : 모든 연산이 적용된 최종 문서에서 해당 문자의 위치
function findItemByCurrentPos(items: CRDTItem[], targetPos: number): {idx:number , endPos: number} { 
    let currPos = 0
    let endPos = 0;
    let idx = 0

    while (currPos < targetPos) {
        if (idx >= items.length) throw Error('item list의 범위 초과')

        const item = items[idx]
        // curState 는 임시 상태(바뀔 수 있음), deleted 는 확정된 상태
        if (item.curState === INSERTED) currPos++
        if (!item.deleted) endPos++

        idx++
    }
    return {idx, endPos}
}

// ID로 인덱스 찾는 함수
// 실제 구현에서는 최적화 필요
function findItemIdxAtId(items: CRDTItem[], lv: LV){
    const idx = items.findIndex(item => item.lv === lv)
    if (idx < 0) throw Error('아이템을 찾을 수 없음')
    return idx
}


function rawIdCmp(a: Id, b: Id): number {
  return a[0] < b[0] ? -1
    : a[0] > b[0] ? 1
    : a[1] - b[1]
}


// 새 아이템을 문서의 '올바른 위치'에 추가
// 올바른 위치는 특정 '왼쪽 문자'와 '오른쪽 문자' 사이를 의미
function integrate<T>(doc: CRDTDoc, oplog: OpLog<T>, newItem: CRDTItem, 
    idx: number, rightIdx: number, endPos: number, snapshot: T[] | null, sink?: PatchSink,){ 
    let scanIdx = idx
    let scanEndPos = endPos

    let left = scanIdx - 1
    let right = rightIdx// apply에서 인덱스 재활용한 버전

    let scanning = false

    //left와 right 사이 탐색
    while (scanIdx < right){
        // 같은 위치에 삽입된 다른 문자
        let other = doc.items[scanIdx]

        // NOT_INSERTED_YET 아니다 == 이미 알고있는 연산이다 == 충돌이 안나니 해결할 필요 없다
        if (other.curState !== NOT_INSERTED_YET) break

        let oleft = other.originLeft === -1 ? -1 : findItemIdxAtId(doc.items, other.originLeft)
        let oright = other.originRight === -1 
            ? doc.items.length 
            : findItemIdxAtId(doc.items, other.originRight)

        // const newItemAgent = oplog.ops[newItem.lv].id[0]
        // const otherAgent = oplog.ops[other.lv].id[0]
        const newId = oplog.ops[newItem.lv].id
        const otherId = oplog.ops[other.lv].id
        // 충돌된 위치에서의 우선순위 규칙
        if (oleft < left 
            // || (oleft === left && oright === right && newItemAgent < otherAgent)) break
            || (oleft === left && oright === right && rawIdCmp(newId, otherId) < 0)) break
        if (oleft === left) scanning = oright < right

        

        if (!other.deleted) scanEndPos++
        scanIdx++

        if (!scanning) {
            idx = scanIdx
            endPos = scanEndPos
        }
    }

    // Idx부터 newItem을 끼워넣고 원래 있던건 newItem 뒤로 미루기 (js array기본메서드)
    doc.items.splice(idx, 0, newItem)

    const op = oplog.ops[newItem.lv]
    if (op.type !== 'ins') throw Error('삭제 연산을 삽입할 수 없음')
    if (snapshot != null) {
        snapshot.splice(endPos, 0, op.content)
        sink?.insert(endPos, String(op.content))// codemirror 반영을 위해 patch 빼기
    }
}



function apply<T>(doc: CRDTDoc, oplog: OpLog<T>, snapshot: T[] | null, opLv: LV, sink?: PatchSink,) {
    const op = oplog.ops[opLv]

    if (op.type === 'del'){
        //Delete

        // 삭제될 아이템 찾기
        let {idx, endPos} = findItemByCurrentPos(doc.items, op.pos)

        // 실제 아이템 위치 찾기 (deleted 된거 포함한 인덱스)
        while (doc.items[idx].curState !== INSERTED){
            if (!doc.items[idx].deleted) endPos++
            idx++
        }
        const item = doc.items[idx] //위의 결과로 찾은 실제 아이템

        if (!item.deleted){
            item.deleted = true
            if (snapshot != null) snapshot.splice(endPos, 1) // snapshot에서 endpos에 있는 문자 빼기 (진짜 삭제)

            sink?.delete(endPos, 1)// codemirror 반영을 위해 patch 빼기
        }

        item.curState = 1 // 위에서 INSERTED(0)까지 스킵했기 때문에 한번만 삭제된게 보장됨

        doc.delTargets[opLv] = item.lv
    } else {
        //Insert

        const {idx, endPos} = findItemByCurrentPos(doc.items, op.pos)
        //delete때와는 다르게 idx에 바로 삽입 가능 => deleted된게 상관 없기 때문
        // 어차피 안보이는 deleted 된 문자 앞에 삽입하나 뒤에 삽입하나 같음

        if (idx >= 1 && doc.items[idx -1].curState !== INSERTED) {
            throw Error('참조해야하는 왼쪽 아이템이 삽입되지 않음')
        }

        // originLeft, originRight의 위치를 계산할때 NOT_INSERTED_YET은 무시해야함
        // 연산이 정의된 시점에 몰랐던 연산이기 때문
        // 왼쪽은 findItemByCurrentPos 내부로직에 의해서 NOT_INSERTED_YET일리가 없음 => 오른쪽만 고려
        const originLeft = idx === 0 ? -1 : doc.items[idx -1].lv
        //let originRight = doc.items[idx].lv
        
        // let originRight = -1
        let originRight: LV | -1 = -1

        // for (let i = idx; i < doc.items.length; i++){
        //     const item2 = doc.items[i]
        //     if (item2.curState !== NOT_INSERTED_YET){
        //         originRight = item2!.lv
        //         break
        //     }
        // }
        let rightIdx = idx
        while (rightIdx < doc.items.length) {
            const item2 = doc.items[rightIdx]
            if (item2.curState !== NOT_INSERTED_YET){
                // originRight = item2.lv
                originRight = (item2.originLeft === originLeft) ? item2.lv : -1
                break
            }
            rightIdx++
        }



        const item: CRDTItem = {
            lv: opLv,
            originLeft,
            originRight,
            deleted: false,
            curState: INSERTED
        }
        doc.itemsByLV[opLv] = item

        // 문서에 아이템 추가
        integrate(doc, oplog, item, idx, rightIdx, endPos, snapshot, sink)
        // integrate(doc, oplog, item, idx, endPos, snapshot)
    }
}

// 그래프를 순회하며 최종 문서 만드는 함수
// checkout 순서에 따라 성능이 달라짐 
// 짧은거 먼저 apply&retreat하는게 이득 
// 이것도 가능하다면 실제 구현에서는 최적화 하기 
function checkout<T>(oplog: OpLog<T>): T[]{
    const doc: CRDTDoc = {
        items: [],
        currentVersion: [],
        delTargets: [],
        itemsByLV: []
    }

    //특정 순간에 문서가 어떻게 생겼는지
    const snapshot: T[] = []

    // 모든 연산을 순회하며 문서에 적용
    for (let lv = 0; lv < oplog.ops.length; lv++){
        do1Operation(doc, oplog, lv, snapshot)
    }

    return snapshot
}


function do1Operation<T>(doc: CRDTDoc, oplog: OpLog<T>, lv: LV, snapshot: T[] | null, sink?: PatchSink,){
    const op = oplog.ops[lv]

    const { aOnly, bOnly } = diff(oplog, doc.currentVersion, op.parents)

    //retreat
    for (const i of aOnly){
        // console.log('retreat',i)
        retreat(doc, oplog, i)
    }
    //advance
    for (const i of bOnly){
        // console.log('advance',i)
        advance(doc, oplog, i)
    }

    //apply
    // console.log('apply', lv)
    apply(doc, oplog, snapshot, lv, sink)
    doc.currentVersion = [lv]
}



type OpsToVisit = {
  commonVersion: LV[],
  sharedOps: LV[],
  bOnlyOps: LV[],
}

// 배열 사전순 비교 함수 a > b : 1 // a == b : 0 // a < b : -1
function compareArrays(a: LV[], b: LV[]): number {
  for (let i = 0; i < a.length; i++) {
    if (b.length <= i) return 1

    const delta = a[i] - b[i]
    if (delta !== 0) return delta
  }

  if (a.length < b.length) return -1
  else return 0
}

// frontier부터 그래프 역순 탐색 --> 공통버전, 각자에게만 있는 연산 구분
function findOpsToVisit(oplog: OpLog<any>, a: LV[], b: LV[]): OpsToVisit {
  // if (a.length === 0 && b.length === 0) return { start: [], common: [], bOnly: [] }

  type MergePoint = {
    v: LV[], 
    isInA: boolean,
  }

  //max heap 기반 우선순위 큐
  const queue = new FastPriorityQueue<MergePoint>((a, b) => {
    return compareArrays(a.v, b.v) > 0
  })

  const enq = (lv: LV[], isInA: boolean) => {
    const mergePoint = {
      v: lv.slice().sort((a, b) => b - a), //내림차순 정렬
      isInA
    }
    queue.add(mergePoint)
  }

  // 병합하려는 두 문서의 frontier버전 넣음 (탐색 시작점)
  enq(a, true)
  enq(b, false)

  let commonVersion: LV[]
  const sharedOps = [], bOnlyOps = []


  // 큐에서 frontier 하나 꺼냄
  // 그 frontier와 같은 merge point가 큐에 더 있으면 같이 소비
  // 그 과정에서 a와 b 양쪽에서 온 동일 merge point가 만났는지 확인
  // 아직 공통 지점이 아니면
  //   frontier가 여러 개면 각각 단일 노드로 분해
  //   단일 노드면 결과 목록에 넣고 그 부모를 다시 큐에 삽입
  // 결국 공통 frontier를 찾으면 종료
  // console.log('a', a, 'b', b)
  while (true) {
    let { v, isInA } = queue.poll()!
    // console.log('deq', v, isInA)
    if (v.length === 0) {
      commonVersion = []
      break
    }

    // 공통의 연산일 때 한번 더 소비(중복 방지)
    while (!queue.isEmpty()) {
      const { v: peekV, isInA: peekIsInA } = queue.peek()!
      if (compareArrays(v, peekV) !== 0) break // 다르면 통과

      queue.poll() // 같으면 한번 더 소비
      if (peekIsInA) isInA = true
    }

    
    if (queue.isEmpty()) {
      commonVersion = v.reverse()
      break
    }

    // 현재 버전이 병합된 버전이라면 (복합 frontier : [9, 6] => [9], [6])
    if (v.length >= 2) {
      for (const vv of v) enq([vv], isInA)// frontier를 분리해서 큐에 넣음
    } else { //아니라면 연산 경로 분류 
      const lv = v[0]
      
      if (isInA) sharedOps.push(lv)// a쪽이면 공유된 연산
      else bOnlyOps.push(lv) // 아니면 b에만 있는 연산

      
      const op = oplog.ops[lv]
      enq(op.parents, isInA)// 부모쪽으로 계속 탐색
    }
  }

  return {
    commonVersion,
    sharedOps: sharedOps.reverse(),
    bOnlyOps: bOnlyOps.reverse()
  }
}

export type Branch<T> = {
    snapshot: T[],
    frontier: LV[],
}

function createBranch<T>(): Branch<T> {
    return {
        snapshot: [],
        frontier: []
    }
}

//최적화된 checkout 함수
// 병합마다 문서 전체를 재생성하지 않고 새로 추가된 연산만 병합
// + 브랜치 기능
function checkoutBetter<T>(oplog: OpLog<T>, branch: Branch<T>, mergeFrontier: LV[] = oplog.frontier, sink?: PatchSink,){
    const {
        commonVersion,
        sharedOps,
        bOnlyOps
     } = findOpsToVisit(oplog, branch.frontier, mergeFrontier)

    const doc: CRDTDoc = {
        items: [],
        currentVersion: commonVersion,
        delTargets: [],
        itemsByLV: []
    }

    // RLE 최적화를 진행한 경우 math max 필요 없이 item 하나만 넣어도 됨
    const placeholderLength = Math.max(...branch.frontier) + 1
    // 더미 CRDT이기 때문에 아무값이나
    for (let i = 0; i < placeholderLength; i++){
        const item: CRDTItem = {
            lv: i + 1e12, // 안좋은 방식 --> 나중에 itemsByLV를 Map 형식으로 바꾸기
            curState: INSERTED,
            deleted: false,
            originLeft: -1,
            originRight: -1
        }
        doc.items.push(item)
        doc.itemsByLV[item.lv] = item
    }

    // const snapshotOpsAsSet = expandVersionToSet(oplog, frontier)
    // const snapshotOps: LV[] = sortLVs([...snapshotOpsAsSet])
    // const newOps: LV[] = sortLVs([ // 진짜 frontier(oplog의)와 기존에 알던 frontier 차이 반환
    //     ...expandVersionToSet(oplog, oplog.frontier)
    //     .difference(snapshotOpsAsSet)
    // ])

    for (const lv of sharedOps) {
        do1Operation(doc, oplog, lv, null)
    }

    for (const lv of bOnlyOps) {
        do1Operation(doc, oplog, lv, branch.snapshot, sink)
        branch.frontier = advanceFrontier(branch.frontier, lv, oplog.ops[lv].parents)
    }

    // console.log('visited:', sharedOps.length + bOnlyOps.length, 'total:',oplog.ops.length)

    //return snapshot
}


//텍스트 에디터 CRDT 클래스
export class CRDTDocument {
    oplog: OpLog<string>
    agent: string

    branch: Branch<string>
    // snapshot: string[]
    // frontier: LV[]

    constructor(agent: string){
        this.oplog = createOplog()
        this.agent = agent
        this.branch = createBranch()
    }

    check() {
        const actualDoc = checkout(this.oplog)
        if (actualDoc.join('') !== this.branch.snapshot.join('')) throw Error('문서 비동기화')
    }

    ins(pos: number, text: string){
        const inserted = [...text]
        localInsert(this.oplog, this.agent, pos, inserted)
        this.branch.snapshot.splice(pos, 0, ...inserted)
        this.branch.frontier = this.oplog.frontier.slice()
    }

    del(pos: number, delLen: number){
        localDelete(this.oplog, this.agent, pos, delLen)
        this.branch.snapshot.splice(pos, delLen)
        this.branch.frontier = this.oplog.frontier.slice()
    }

    getString(){
        // return checkout(this.oplog).join('')
        return this.branch.snapshot.join('')
    }

    mergeFrom(other: CRDTDocument): TextPatch[] {
        mergeInto(this.oplog, other.oplog)

        const patches: TextPatch[] = []

        const sink: PatchSink = {
            insert(pos, text) {
            patches.push({ type: 'insert', pos, text })
            },
            delete(pos, length) {
            patches.push({ type: 'delete', pos, length })
            },
        }

        // this.snapshot = checkout(this.oplog)
        checkoutBetter(this.oplog, this.branch, this.oplog.frontier, sink)
        return compactPatches(patches)
    }
    

    reset(){
        this.oplog = createOplog()
        this.branch = createBranch()
    }

    /*
        연산의 증분만 전송하기 위한 코드
    */

    // 내 현재 버전(RemoteVersion)을 상대방에게 알려주기 위해 추출
    getVersion(): RemoteVersion {
        // 객체 복사본 반환
        return { ...this.oplog.version };
    }
    
    // 상대방의 버전을 보고, 내가 가진 연산 중 상대방이 모르는 연산(증가분)만 골라냄
    getMissingOps(remoteVersion: RemoteVersion): TransferOp<string>[] {
        const missingOps: TransferOp<string>[] = [];

        for (const op of this.oplog.ops) {
            const [agent, seq] = op.id;
            // 상대방이 해당 agent에 대해 아는 마지막 seq. 모르면 -1
            const remoteSeq = remoteVersion[agent] ?? -1;

            // seq가 상대방보다 작으면 이미 아는 연산 -> 스킵
            if (seq  <= remoteSeq) continue

            // * LV인 부모를 ID로 변환
            const parentIds = op.parents.map(lv => this.oplog.ops[lv].id);
            
            missingOps.push({
                type: op.type,
                pos: op.pos,
                ...(op.type === "ins" ? {content: op.content} : {}), // del 연산의 경우 content x
                id: op.id,
                parentIds: parentIds
            } as TransferOp<string>);
            
        }
        return missingOps;
    }
    

    mergeDelta(deltaOps: TransferOp<string>[]): TextPatch[] {
        for (const remoteOp of deltaOps) {
            if (remoteOp.type === 'ins') {
                pushRemoteOp(
                    this.oplog,
                    {
                    type: 'ins',
                    content: remoteOp.content,
                    pos: remoteOp.pos,
                    id: remoteOp.id,
                    parents: [],
                    },
                    remoteOp.parentIds
                )
            } else {
            pushRemoteOp(
                this.oplog,
                {
                type: 'del',
                pos: remoteOp.pos,
                id: remoteOp.id,
                parents: [],
                },
                remoteOp.parentIds
            )
        }
    }

    const patches: TextPatch[] = []

    const sink: PatchSink = {
        insert(pos, text) {
        patches.push({ type: 'insert', pos, text })
        },
        delete(pos, length) {
        patches.push({ type: 'delete', pos, length })
        },
  }

  checkoutBetter(this.oplog, this.branch, this.oplog.frontier, sink)
  return compactPatches(patches)
}


exportOplog(): FullSyncOplog<string> {
  return structuredClone(this.oplog) as FullSyncOplog<string>
}

applyFullSync(remote: FullSyncOplog<string>): TextPatch[] {
  const remoteDoc = new CRDTDocument(this.agent)
  remoteDoc.oplog = structuredClone(remote) as any

  return this.mergeFrom(remoteDoc)
}


}


// 테스트 

// const oplog1 = createOplog<string>()
// const oplog2 = createOplog<string>()

// localInsert(oplog1, 'danny', 0, [..."hi"])

// mergeInto(oplog1, oplog2)
// mergeInto(oplog2, oplog1)

// localDelete(oplog1, 'danny', 1, 1)
// localInsert(oplog1, 'danny', 1, [..."ey"])
// localInsert(oplog2, 'john', 2, [..." Tom"])

// mergeInto(oplog1, oplog2)
// mergeInto(oplog2, oplog1)

// //console.log(oplog1)
// console.table(oplog1.ops)
// console.table(oplog2.ops)

// const result1 = checkout(oplog1)
// console.log(result1)
// const result2 = checkout(oplog2)
// console.log(result2)