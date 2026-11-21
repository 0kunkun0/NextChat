import React, { useEffect, useState } from "react";
import Locale from "../locales";
import { IconButton } from "./button";
import { Modal, PasswordInput } from "./ui-lib";
import styles from "./password-modal.module.scss";
import { createPortalLayer } from "../utils/portal";

/**
 * 输入加密密码的弹窗。
 *
 * 和 showPrompt 一样是命令式调用（不污染 Settings 的渲染树），
 * 但用 password 类型的 input（不回显），并带「在此设备记住」勾选。
 */
export function askEncryptPassword(options: {
  title?: string;
  tip?: string;
  submitText?: string;
  withConfirm?: boolean;
  showRemember?: boolean;
  rememberDefault?: boolean;
}): Promise<{ password: string; remember: boolean } | null> {
  // 和其他弹层一样挂到固定容器里，不直接增删 document.body 的子节点
  const layer = createPortalLayer("modal-mask");
  const close = () => layer.destroy();

  return new Promise((resolve) => {
    const finish = (value: { password: string; remember: boolean } | null) => {
      close();
      resolve(value);
    };

    layer.root.render(
      <PasswordDialog
        options={options}
        onCancel={() => finish(null)}
        onOk={finish}
      />,
    );
  });
}

function PasswordDialog(props: {
  options: Parameters<typeof askEncryptPassword>[0];
  onCancel: () => void;
  onOk: (value: { password: string; remember: boolean }) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(
    props.options.rememberDefault ?? false,
  );
  const [error, setError] = useState("");

  const submit = () => {
    if (!password) {
      setError(Locale.Settings.Sync.Encryption.EmptyPassword);
      return;
    }
    if (props.options.withConfirm && password !== confirm) {
      setError(Locale.Settings.Sync.Encryption.PasswordMismatch);
      return;
    }
    props.onOk({ password, remember });
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
      if (e.key === "Enter") submit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Modal
      title={props.options.title ?? Locale.Settings.Sync.Encryption.Title}
      onClose={props.onCancel}
      actions={[
        <IconButton
          key="cancel"
          text={Locale.UI.Cancel}
          onClick={props.onCancel}
        />,
        <IconButton
          key="ok"
          type="primary"
          text={props.options.submitText ?? Locale.UI.Confirm}
          onClick={submit}
        />,
      ]}
    >
      <div className={styles["password-dialog"]}>
        {props.options.tip && (
          <div className={styles["tip"]}>{props.options.tip}</div>
        )}

        <PasswordInput
          value={password}
          placeholder={Locale.Settings.Sync.Encryption.Password}
          autoFocus
          onChange={(e) => {
            setPassword(e.currentTarget.value);
            setError("");
          }}
        />

        {props.options.withConfirm && (
          <PasswordInput
            value={confirm}
            placeholder={Locale.Settings.Sync.Encryption.PasswordConfirm}
            onChange={(e) => {
              setConfirm(e.currentTarget.value);
              setError("");
            }}
          />
        )}

        {props.options.showRemember && (
          <label className={styles["remember"]}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.currentTarget.checked)}
            />
            <span>{Locale.Settings.Sync.Encryption.Remember}</span>
          </label>
        )}

        {error && <div className={styles["error"]}>{error}</div>}
      </div>
    </Modal>
  );
}
