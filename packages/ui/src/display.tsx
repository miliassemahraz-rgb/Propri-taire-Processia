'use client';

import type { ReactNode } from 'react';
import {
  Label,
  Radio,
  RadioGroup,
  Tab,
  TabList,
  TabPanel,
  Tabs as AriaTabs,
  type Key,
} from 'react-aria-components';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Pastille de statut : le sens ne dépend jamais de la seule couleur (le texte le porte). */
export function StatusBadge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return <span className={`pr-badge pr-badge--${tone}`}>{children}</span>;
}

export interface ProgressMeterProps {
  /** Valeur entre 0 et 1. */
  value: number;
  label: string;
  tone?: 'info' | 'success';
  /** Texte affiché à côté de la barre (par défaut le pourcentage). */
  valueText?: string;
}

/** Jauge de progression (rôle `progressbar` annoncé avec sa valeur). */
export function ProgressMeter({ value, label, tone = 'info', valueText }: ProgressMeterProps) {
  const clamped = Math.min(1, Math.max(0, value));
  const percent = Math.round(clamped * 100);
  return (
    <div className="pr-meter">
      <div
        className="pr-meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText ?? `${percent} %`}
      >
        <div className={`pr-meter-fill pr-meter-fill--${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="pr-meter-text">{valueText ?? `${percent} %`}</span>
    </div>
  );
}

export interface DataTableProps {
  caption: string;
  children: ReactNode;
}

/** Tableau sémantique avec légende (masquée visuellement) et défilement horizontal si besoin. */
export function DataTable({ caption, children }: DataTableProps) {
  return (
    // Région défilable : focalisable pour que le clavier puisse faire défiler le tableau (RGAA 7.3).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="pr-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="pr-table">
        <caption className="pr-visually-hidden">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  label: string;
  items: TabItem[];
  selected?: string;
  onSelectionChange?: (id: string) => void;
}

/** Onglets accessibles (flèches, Début, Fin). */
export function Tabs({ label, items, selected, onSelectionChange }: TabsProps) {
  const controlled =
    selected === undefined
      ? {}
      : {
          selectedKey: selected,
          onSelectionChange: (key: Key) => onSelectionChange?.(String(key)),
        };
  return (
    <AriaTabs className="pr-tabs" {...controlled}>
      <TabList aria-label={label} className="pr-tablist">
        {items.map((item) => (
          <Tab key={item.id} id={item.id} className="pr-tab">
            {item.label}
          </Tab>
        ))}
      </TabList>
      {items.map((item) => (
        <TabPanel key={item.id} id={item.id} className="pr-tabpanel">
          {item.content}
        </TabPanel>
      ))}
    </AriaTabs>
  );
}

export interface SegmentedOption {
  id: string;
  label: string;
}

export interface SegmentedControlProps {
  label: string;
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
}

/** Choix exclusif (groupe de boutons radio) : sélecteur du mode simple / expert. */
export function SegmentedControl({ label, options, value, onChange }: SegmentedControlProps) {
  return (
    <RadioGroup value={value} onChange={onChange} className="pr-segmented" orientation="horizontal">
      <Label className="pr-label pr-label--small">{label}</Label>
      <div className="pr-segmented-options">
        {options.map((option) => (
          <Radio key={option.id} value={option.id} className="pr-segment">
            {option.label}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

export interface NoticeProps {
  tone: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: ReactNode;
  /** `alert` annonce immédiatement le message (erreurs), `status` poliment. */
  role?: 'alert' | 'status';
}

/** Encadré d'information, d'avertissement ou d'erreur. */
export function Notice({ tone, title, children, role }: NoticeProps) {
  return (
    <div className={`pr-notice pr-notice--${tone}`} role={role}>
      {title ? <strong className="pr-notice-title">{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

/** Lien d'évitement : premier élément focalisable de la page. */
export function SkipLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="pr-skip-link" href={href}>
      {children}
    </a>
  );
}
