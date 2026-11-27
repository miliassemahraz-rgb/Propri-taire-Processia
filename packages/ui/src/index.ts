/** @processia/ui : composants accessibles (React Aria Components) et thème, WP-07. */
export const PACKAGE_NAME = '@processia/ui' as const;

export { Button, Checkbox, Select, TextField } from './controls.js';
export type {
  ButtonProps,
  ButtonVariant,
  CheckboxProps,
  SelectOption,
  SelectProps,
  TextFieldProps,
} from './controls.js';
export {
  DataTable,
  Notice,
  ProgressMeter,
  SegmentedControl,
  SkipLink,
  StatusBadge,
  Tabs,
} from './display.js';
export type {
  BadgeTone,
  DataTableProps,
  NoticeProps,
  ProgressMeterProps,
  SegmentedControlProps,
  TabItem,
  TabsProps,
} from './display.js';
export { Dialog, DialogTrigger, PopoverPanel, ToastHost, showToast } from './overlays.js';
export type { DialogProps, PopoverPanelProps, ToastData, ToastTone } from './overlays.js';
