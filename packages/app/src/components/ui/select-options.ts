import { Children, Fragment, isValidElement, type ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: ReactNode;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  group?: string;
}

/** Read declarative choices without mounting any browser select/option elements. */
export function selectOptionsFromChildren(children: ReactNode, group?: string, groupDisabled = false): SelectOption[] {
  const result: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: string | number; label?: string; disabled?: boolean; hidden?: boolean; children?: ReactNode }>(child)) return;
    const props = child.props;
    if (props.hidden) return;
    if (child.type === Fragment || child.type === "optgroup") {
      result.push(...selectOptionsFromChildren(props.children, child.type === "optgroup" ? props.label : group, groupDisabled || !!props.disabled));
    } else if (child.type === "option") {
      result.push({ value: String(props.value ?? ""), label: props.label ?? props.children, disabled: groupDisabled || !!props.disabled, ...(group ? { group } : {}) });
    }
  });
  return result;
}
