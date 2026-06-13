/**
 * ConfirmDialog - 通用确认弹窗组件
 *
 * 替代 window.confirm，提供符合项目风格的确认对话框。
 */
import React from 'react';

import { cn } from '@/shared/utils/utils';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'destructive',
  onConfirm,
}: ConfirmDialogProps) {
  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" hideCloseButton data-testid="dialog-confirm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <button
            onClick={() => onOpenChange(false)}
            data-testid="dialog-confirm-cancel-btn"
            className="px-4 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-surface-1 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleConfirm}
            data-testid="dialog-confirm-ok-btn"
            data-variant={variant}
            className={cn(
              'px-4 py-2 text-sm rounded-lg transition-colors',
              variant === 'destructive'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
