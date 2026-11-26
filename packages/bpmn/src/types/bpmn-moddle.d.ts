/** Déclaration minimale de `bpmn-moddle` (le paquet n'expose ses types que par un sous-chemin). */
declare module 'bpmn-moddle' {
  export interface ModdleElement {
    $type: string;
    $parent?: ModdleElement;
    $attrs?: Record<string, string>;
    id?: string;
    [key: string]: unknown;
    get(name: string): unknown;
    set(name: string, value: unknown): void;
  }
  export interface ModdleWarning {
    message: string;
    element?: ModdleElement;
  }
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(element: ModdleElement, options?: { format?: boolean }): Promise<{ xml: string }>;
    fromXML(
      xml: string,
      options?: Record<string, unknown>,
    ): Promise<{ rootElement: ModdleElement; warnings: ModdleWarning[] }>;
  }
}
