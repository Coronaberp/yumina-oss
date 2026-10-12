import { isVariableActive, migrateWorldDefinition, type GameState, type WorldDefinition } from "@yumina/engine";

/** Read authoritative session state. The sandbox receives no definitions or rules. */
export function visibleSessionVariables(session: {
  world?: { schema?: unknown };
  state?: GameState;
}): Record<string, unknown> {
  if (!session.world?.schema || !session.state?.variables) return {};
  const world = migrateWorldDefinition(session.world.schema as WorldDefinition);
  return Object.fromEntries(world.variables.flatMap(variable =>
    !variable.internal && isVariableActive(variable, session.state!) && Object.hasOwn(session.state!.variables, variable.id)
      ? [[variable.id, session.state!.variables[variable.id]]] : []));
}
