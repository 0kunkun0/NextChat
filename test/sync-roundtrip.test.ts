import "./setup-prompts-fetch";

import { StoreKey } from "../app/constant";
import { createMessage, useChatStore } from "../app/store/chat";
import {
  getLocalAppState,
  mergeAppState,
  setLocalAppState,
} from "../app/utils/sync";

const CONTENT = "第一段\n\n第二段\n\n第三段";

function collectChatContent(): string[] {
  const state = getLocalAppState();
  return state[StoreKey.Chat].sessions.flatMap((s: any) =>
    s.messages.map((m: any) => String(m.content)),
  );
}

/** 模拟“导出 → 在文件里改掉这条消息 → 再导入” */
function importFile(file: string) {
  const remote = JSON.parse(file);
  const local = getLocalAppState();
  mergeAppState(local, remote, true);
  setLocalAppState(local);
}

describe("export / import round trip", () => {
  beforeEach(() => {
    useChatStore.getState().clearSessions();
  });

  test("keeps blank lines when importing into a clean state", () => {
    const message = createMessage({ role: "assistant", content: CONTENT });
    const session = useChatStore.getState().currentSession();
    useChatStore.getState().updateTargetSession(session, (target) => {
      target.messages = [message];
    });

    const file = JSON.stringify(getLocalAppState());

    useChatStore.getState().clearSessions();
    importFile(file);

    expect(collectChatContent()).toContain(CONTENT);
  });

  test("applies the edited content when the session already exists locally", () => {
    // 本地已有的旧内容
    const message = createMessage({
      role: "assistant",
      content: "第一段\n第二段",
    });
    const session = useChatStore.getState().currentSession();
    useChatStore.getState().updateTargetSession(session, (target) => {
      target.messages = [message];
    });

    // 备份文件里把同一条消息改成了带空行的版本
    const backup = JSON.parse(JSON.stringify(getLocalAppState()));
    backup[StoreKey.Chat].sessions[0].messages[0].content = CONTENT;

    importFile(JSON.stringify(backup));

    // 导入的内容必须覆盖本地旧内容，否则“改备份再导入”看起来就像空行被吞了
    expect(collectChatContent()).toContain(CONTENT);
  });

  test("keeps locally added messages that are not in the backup", () => {
    const session = useChatStore.getState().currentSession();
    const oldMessage = createMessage({ role: "assistant", content: "旧消息" });
    const localOnly = createMessage({ role: "user", content: "本地新消息" });

    useChatStore.getState().updateTargetSession(session, (target) => {
      target.messages = [oldMessage];
    });
    const backup = JSON.parse(JSON.stringify(getLocalAppState()));

    useChatStore.getState().updateTargetSession(session, (target) => {
      target.messages = [oldMessage, localOnly];
    });

    importFile(JSON.stringify(backup));

    const contents = collectChatContent();
    expect(contents).toContain("本地新消息");
    expect(contents).toContain("旧消息");
  });
});
