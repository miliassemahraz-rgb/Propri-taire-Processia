'use client';

import type { ReactNode } from 'react';
import { t } from '@processia/i18n';
import {
  Button as AriaButton,
  Checkbox as AriaCheckbox,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  TextArea,
  TextField as AriaTextField,
  type ButtonProps as AriaButtonProps,
  type CheckboxProps as AriaCheckboxProps,
  type Key,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

export interface ButtonProps extends AriaButtonProps {
  variant?: ButtonVariant;
}

/** Bouton accessible (cible d'au moins 44 px). */
export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={
        typeof className === 'function'
          ? className
          : `pr-button pr-button--${variant} ${className ?? ''}`
      }
    />
  );
}

export interface TextFieldProps extends AriaTextFieldProps {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  multiline?: boolean;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'email';
}

/** Champ de saisie : libellé, aide et message d'erreur reliés par React Aria. */
export function TextField({
  label,
  description,
  errorMessage,
  multiline = false,
  placeholder,
  autoComplete,
  inputMode,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField {...props} className="pr-field">
      <Label className="pr-label">{label}</Label>
      {multiline ? (
        <TextArea className="pr-input pr-input--multiline" placeholder={placeholder} rows={4} />
      ) : (
        <Input
          className="pr-input"
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
        />
      )}
      {description ? (
        <Text slot="description" className="pr-hint">
          {description}
        </Text>
      ) : null}
      <FieldError className="pr-error">{errorMessage}</FieldError>
    </AriaTextField>
  );
}

export interface SelectOption {
  id: string;
  label: string;
}

export interface SelectProps {
  label: ReactNode;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  description?: ReactNode;
}

/** Liste déroulante accessible (clavier, annonce du libellé et de la valeur). */
export function Select({
  label,
  options,
  value,
  onChange,
  placeholder,
  isRequired,
  isDisabled,
  description,
}: SelectProps) {
  return (
    <AriaSelect
      className="pr-field"
      selectedKey={value}
      onSelectionChange={(key: Key | null) => {
        if (key !== null) onChange(String(key));
      }}
      placeholder={placeholder}
      isRequired={isRequired}
      isDisabled={isDisabled}
    >
      <Label className="pr-label">{label}</Label>
      <AriaButton className="pr-select-button">
        <SelectValue />
        <span aria-hidden="true">{t('ui.dropdown')}</span>
      </AriaButton>
      {description ? (
        <Text slot="description" className="pr-hint">
          {description}
        </Text>
      ) : null}
      <FieldError className="pr-error" />
      <Popover className="pr-popover">
        <ListBox className="pr-listbox">
          {options.map((option) => (
            <ListBoxItem
              key={option.id}
              id={option.id}
              textValue={option.label}
              className="pr-option"
            >
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export interface CheckboxProps extends Omit<AriaCheckboxProps, 'children'> {
  children: ReactNode;
}

export function Checkbox({ children, ...props }: CheckboxProps) {
  return (
    <AriaCheckbox {...props} className="pr-checkbox">
      <span className="pr-checkbox-box" aria-hidden="true" />
      <span>{children}</span>
    </AriaCheckbox>
  );
}
