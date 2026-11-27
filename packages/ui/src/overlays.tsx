'use client';

import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
  Popover,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
  Button as AriaButton,
  Text,
} from 'react-aria-components';
import { t } from '@processia/i18n';
import { Button } from './controls.js';

export { DialogTrigger };

export interface DialogProps {
  title: ReactNode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** Dialogue modal : focus piégé, Échap, retour du focus au déclencheur. */
export function Dialog({ title, isOpen, onOpenChange, children }: DialogProps) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="pr-overlay">
      <Modal className="pr-modal">
        <AriaDialog className="pr-dialog">
          {({ close }) => (
            <>
              <div className="pr-dialog-header">
                <Heading slot="title" className="pr-dialog-title">
                  {title}
                </Heading>
                <Button variant="quiet" onPress={close} aria-label={t('ui.close')}>
                  <span aria-hidden="true">{t('ui.cross')}</span>
                </Button>
              </div>
              {children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export interface PopoverPanelProps {
  title: ReactNode;
  children: ReactNode;
}

/** Panneau flottant ancré à un bouton (`DialogTrigger`), par exemple le centre de notifications. */
export function PopoverPanel({ title, children }: PopoverPanelProps) {
  return (
    <Popover className="pr-popover pr-popover--panel" placement="bottom end">
      <AriaDialog className="pr-dialog pr-dialog--panel">
        <Heading slot="title" className="pr-dialog-title">
          {title}
        </Heading>
        {children}
      </AriaDialog>
    </Popover>
  );
}

export type ToastTone = 'info' | 'success' | 'error';
export interface ToastData {
  title: string;
  description?: string;
  tone: ToastTone;
}

const queue = new ToastQueue<ToastData>({ maxVisibleToasts: 4 });

/** Affiche une notification éphémère (annoncée aux lecteurs d'écran). */
export function showToast(data: ToastData): void {
  queue.add(data, { timeout: data.tone === 'error' ? 10_000 : 5_000 });
}

/** Région des notifications : à placer une fois, dans la mise en page. */
export function ToastHost() {
  return (
    <ToastRegion queue={queue} className="pr-toast-region" aria-label={t('ui.notifications')}>
      {({ toast }) => (
        <Toast toast={toast} className={`pr-toast pr-toast--${toast.content.tone}`}>
          <ToastContent>
            <Text slot="title" className="pr-toast-title">
              {toast.content.title}
            </Text>
            {toast.content.description ? (
              <Text slot="description" className="pr-toast-description">
                {toast.content.description}
              </Text>
            ) : null}
          </ToastContent>
          <AriaButton slot="close" className="pr-toast-close" aria-label={t('ui.close')}>
            <span aria-hidden="true">{t('ui.cross')}</span>
          </AriaButton>
        </Toast>
      )}
    </ToastRegion>
  );
}
