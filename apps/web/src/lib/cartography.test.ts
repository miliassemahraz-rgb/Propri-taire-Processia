import type { FlowOverviewDto, FlowProcessDto } from '@processia/contracts';
import { describe, expect, it } from 'vitest';
import { flowCounts, groupByMacro, mappingOpen, processPending } from './cartography';

const process = (code: string, macroCode: string, extra: Partial<FlowProcessDto> = {}) =>
  ({
    id: code,
    code,
    label: `Processus ${code}`,
    macroCode,
    macroLabel: `Macro ${macroCode}`,
    flowBuilt: false,
    tasks: [],
    pendingCount: 0,
    nodeCount: 0,
    ...extra,
  }) satisfies FlowProcessDto;

describe('cartographie : fonctions pures', () => {
  it('regroupe par macroprocessus dans l’ordre naturel des codes', () => {
    const groups = groupByMacro([
      process('P04.10', 'P04'),
      process('P04.2', 'P04'),
      process('P01.1', 'P01'),
    ]);
    expect(groups.map((g) => g.macroCode)).toEqual(['P01', 'P04']);
    expect(groups[1]?.processes.map((p) => p.code)).toEqual(['P04.2', 'P04.10']);
  });

  it('compte les processus construits et les éléments à examiner (niveau 3 compris)', () => {
    const overview: FlowOverviewDto = {
      lastRun: null,
      processes: [
        process('P01.1', 'P01'),
        process('P01.2', 'P01', {
          flowBuilt: true,
          pendingCount: 4,
          tasks: [{ id: 't', code: 'P01.2.1', label: 'T', detailed: true, pendingCount: 3 }],
        }),
      ],
    };
    expect(flowCounts(overview)).toEqual({ total: 2, built: 1, toBuild: 1, pending: 7 });
    expect(processPending(overview.processes[1] as FlowProcessDto)).toBe(7);
    expect(flowCounts(null)).toEqual({ total: 0, built: 0, toBuild: 0, pending: 0 });
  });

  it('la cartographie est ouverte à partir de la phase « mapping »', () => {
    expect(mappingOpen('analysis')).toBe(false);
    expect(mappingOpen('mapping')).toBe(true);
    expect(mappingOpen('transformation')).toBe(true);
  });
});
