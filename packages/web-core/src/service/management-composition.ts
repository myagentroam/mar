import { inject, type Component, type InjectionKey } from 'vue';
import type { AdminState } from './admin-auth-service.js';
import type { NodeSummary } from '../model/node.js';
import type { NodeUpgradeProgress } from '../model/node-upgrade.js';

export interface ManagementPageContext {
  readonly admin: AdminState;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly nodes: readonly NodeSummary[];
  readonly nodeUpgradeProgress?: Readonly<Record<string, NodeUpgradeProgress | null>>;
  readonly onlineNodeCount: number;
  readonly serverVersion: string | undefined;
}

export interface ManagementPageProps {
  readonly request: ManagementPageContext['request'];
  readonly writable?: boolean;
  readonly nodes?: readonly NodeSummary[];
  readonly nodeUpgradeProgress?: Readonly<Record<string, NodeUpgradeProgress | null>>;
  readonly authenticated?: boolean;
  readonly onlineNodeCount?: number;
  readonly nodeCount?: number;
  readonly isAdmin?: boolean;
  readonly serverVersion?: string;
  readonly extension?: Component;
  readonly logoUrl?: string;
}

export interface ManagementPageDefinition<
  Section extends string = string,
  Props extends ManagementPageProps = ManagementPageProps
> {
  readonly id: Section;
  readonly order: number;
  readonly labelKey: string;
  readonly component: Component;
  readonly visible: (admin: AdminState) => boolean;
  readonly props: (context: ManagementPageContext) => Props;
}

export interface ManagementComposition<
  Section extends string = string,
  Props extends ManagementPageProps = ManagementPageProps
> {
  items(admin: AdminState): readonly {
    readonly id: Section;
    readonly labelKey: string;
  }[];
  resolve(section: Section, admin: AdminState): ManagementPageDefinition<Section, Props>;
}

export const MANAGEMENT_COMPOSITION_KEY: InjectionKey<ManagementComposition> =
  Symbol('management-composition');

export function createManagementComposition<
  Section extends string,
  Props extends ManagementPageProps
>(
  definitions: readonly ManagementPageDefinition<Section, Props>[]
): ManagementComposition<Section, Props> {
  const pages = new Map<string, ManagementPageDefinition<Section, Props>>();
  for (const definition of definitions) {
    if (pages.has(definition.id)) throw new Error('WEB_MANAGEMENT_PAGE_DUPLICATE');
    pages.set(definition.id, Object.freeze({ ...definition }));
  }
  const system = pages.get('system');
  if (system === undefined) throw new Error('WEB_MANAGEMENT_SYSTEM_PAGE_REQUIRED');
  const ordered = [...pages.values()].sort((left, right) => left.order - right.order);
  return {
    items: (admin) =>
      ordered.filter((page) => page.visible(admin)).map(({ id, labelKey }) => ({ id, labelKey })),
    resolve(section, admin) {
      const page = pages.get(section);
      if (page?.visible(admin)) return page;
      if (!system.visible(admin)) throw new Error('WEB_MANAGEMENT_SYSTEM_PAGE_UNAVAILABLE');
      return system;
    }
  };
}

export function useManagementComposition<
  Section extends string = string,
  Props extends ManagementPageProps = ManagementPageProps
>(): ManagementComposition<Section, Props> {
  const composition = inject(MANAGEMENT_COMPOSITION_KEY);
  if (composition === undefined) throw new Error('WEB_MANAGEMENT_COMPOSITION_REQUIRED');
  return composition as ManagementComposition<Section, Props>;
}
