import { Annotation, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { CollabCore } from "./collabCore.js"

// 트랜잭션의 출처를 구분하기 위한 꼬리표, true면 원격 연산
export const remoteAnnotation = Annotation.define<boolean>()

//codemirror 와 collabcore 연결 (에디터와 문서 상태 동기화)
// 사용자 입력 -> core로 전달
// core의 remote patch -> CodeMirror에 반영
export class CodeMirrorBinding {
  view: EditorView
  core: CollabCore

  constructor(core: CollabCore, parent: HTMLElement) {
    this.core = core

    // 에디터 리스너: 에디터에 무언가 입력했을 때 자동실행 (로컬)
    const listener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return// 변경사항 없으면 무시

      const isRemote = update.transactions.some(tr =>
        tr.annotation(remoteAnnotation)
      )// 원격 연산인지
      if (isRemote) return //원격연산이면 무시 (무한 루프 방지)

      // 변경사항 추출 후 CollabCore로 전달
      for (const tr of update.transactions) {
        tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          core.applyLocalChange({
            from: fromA,
            to: toA,
            insert: inserted.toString(),
          })
        })
      }
    })

    // 에디터 초기 상태 구성
    const state = EditorState.create({
      doc: "",
      extensions: [basicSetup, javascript(), listener],
    })

    // 실제 DOM에 에디터 인스턴스 생성
    this.view = new EditorView({
      state,
      parent,
    })

    //원격 이벤트 구독: 다른 사용자가 문서를 수정하여 Core로부터 패치가 올 때 실행
    core.onRemotePatches((patches) => {
      if (patches.length === 0) return

      // 에디터 내용 업데이트
      this.view.dispatch({
        changes: patches.map((p) =>
          p.type === "insert"
            ? { from: p.pos, insert: p.text }
            : { from: p.pos, to: p.pos + p.length, insert: "" }
        ),
        annotations: remoteAnnotation.of(true),
      })
    })

    
    core.onReplaceText((text) => {
      this.view.dispatch({
        changes: {
          from: 0,
          to: this.view.state.doc.length,
          insert: text,
        },
        annotations: remoteAnnotation.of(true),
      })
    })
  }
}