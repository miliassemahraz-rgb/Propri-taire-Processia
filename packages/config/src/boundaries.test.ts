import { describe, expect, it } from 'vitest';
import { allowedDependencies, workspacePackages } from '../eslint/boundaries.mjs';

/** Les dépendances entre paquets doivent former un graphe sans cycle (spécification 1.2). */
describe('frontières entre paquets', () => {
  it('ne contient aucun cycle', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new Error(`Cycle de dépendances autour de ${name}`);
      visiting.add(name);
      for (const dep of allowedDependencies[`packages/${name}`] ?? []) visit(dep);
      visiting.delete(name);
      done.add(name);
    };
    expect(() => workspacePackages.forEach(visit)).not.toThrow();
  });

  it('couvre tous les paquets, et model ne dépend de rien', () => {
    for (const name of workspacePackages) {
      expect(allowedDependencies).toHaveProperty([`packages/${name}`]);
    }
    expect(allowedDependencies['packages/model']).toEqual([]);
  });

  it("interdit l'import de ai côté navigateur", () => {
    expect(allowedDependencies['apps/web']).not.toContain('ai');
    expect(allowedDependencies['packages/ui']).not.toContain('ai');
  });
});
