import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { ReactNode } from "react";

import { useTheme } from "@termcn/hooks/use-theme";

export interface DialogProps {
  title?: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  variant?: "default" | "danger";
  isOpen?: boolean;
  interactive?: boolean;
}

export const Dialog = ({
  title,
  children,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  variant = "default",
  isOpen = false,
  interactive = true,
}: DialogProps) => {
  const theme = useTheme();
  const [focusedButton, setFocusedButton] = useState<0 | 1>(0);

  useKeyboard((key) => {
    if (!isOpen || !interactive) {
      return;
    }
    if (key.name === "tab" || key.name === "left" || key.name === "right") {
      setFocusedButton((prev) => (prev === 0 ? 1 : 0));
    } else if (key.name === "return") {
      if (focusedButton === 1) {
        onConfirm?.();
      } else {
        onCancel?.();
      }
    } else if (key.name === "escape") {
      onCancel?.();
    }
  });

  if (!isOpen) {
    return null;
  }

  const confirmColor =
    variant === "danger" ? (theme.colors.error ?? "red") : theme.colors.primary;

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={
        variant === "danger"
          ? (theme.colors.error ?? "red")
          : theme.colors.primary
      }
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      {title && (
        <box marginBottom={1}>
          <text
            fg={
              variant === "danger"
                ? (theme.colors.error ?? "red")
                : theme.colors.primary
            }
          >
            <b>{title}</b>
          </text>
        </box>
      )}
      <box marginBottom={1} flexDirection="column">
        {children}
      </box>
      {interactive ? (
      <box flexDirection="row" gap={2} justifyContent="flex-end" marginTop={1}>
        <text
          fg={
            focusedButton === 0
              ? theme.colors.foreground
              : theme.colors.mutedForeground
          }
          attributes={focusedButton === 0 ? TextAttributes.INVERSE : 0}
        >
          {focusedButton === 0 ? (
            <b>{` ${cancelLabel} `}</b>
          ) : (
            ` ${cancelLabel} `
          )}
        </text>
        <text
          fg={focusedButton === 1 ? confirmColor : theme.colors.mutedForeground}
          attributes={focusedButton === 1 ? TextAttributes.INVERSE : 0}
        >
          {focusedButton === 1 ? (
            <b>{` ${confirmLabel} `}</b>
          ) : (
            ` ${confirmLabel} `
          )}
        </text>
      </box>
      ) : null}
    </box>
  );
};
