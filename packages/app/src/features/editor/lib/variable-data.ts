import type { Variable } from "@yumina/engine";

export type VariableDataType = "number" | "string" | "boolean" | "list" | "group" | "choice";
export function variableDataType(variable: Pick<Variable,"type"|"defaultValue"|"enumValues">): VariableDataType {
  if (variable.type === "json") return Array.isArray(variable.defaultValue) ? "list" : "group";
  return variable.type === "string" && variable.enumValues !== undefined ? "choice" : variable.type;
}
export function variableTypeUpdate(type: VariableDataType, current?: Variable): Partial<Variable> {
  if (current?.type === "string" && (type === "string" || type === "choice")) {
    return {type:"string",defaultValue:current.defaultValue,defaultValueText:undefined,
      enumValues:type === "choice" ? current.enumValues ?? (typeof current.defaultValue === "string" && current.defaultValue.length <= 1000 ? [current.defaultValue] : []) : undefined};
  }
  return { type: type === "list" || type === "group" ? "json" : type === "choice" ? "string" : type,
    defaultValue: type === "number" ? 0 : type === "boolean" ? false : type === "list" ? [] : type === "group" ? {} : "",
    defaultValueText: undefined, enumValues: type === "choice" ? [] : undefined };
}
/** Converting a stored list into choices is always an explicit author action. */
export function listToChoices(value: unknown, startingValue: string): Partial<Variable> | null {
  if (!Array.isArray(value) || !value.length || value.length > 500 || value.some(item => typeof item !== "string" || item.length > 1000)) return null;
  const options = [...new Set(value as string[])];
  if (!options.includes(startingValue)) return null;
  return {type:"string",enumValues:options,defaultValue:startingValue,defaultValueText:undefined};
}

/** Read exact authored progression ladders, without executing rules or guessing from prose. */
export function authoredVariableChoices(reactions: unknown[]): Record<string,string[]> {
  const result: Record<string,string[]> = Object.create(null);
  const conflicts = new Set<string>();
  const record = (value: unknown): Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
  for (const item of reactions) {
    const reaction=record(item);
    if(reaction.enabled===false || !Array.isArray(reaction.then)) continue;
    for (const action of reaction.then) {
      const event=record(record(action).event);
      if(event.type!=="progression:resolve" || !Array.isArray(event.tracks)) continue;
      const ladders=record(event.ladders);
      for(const item of event.tracks){
        const track=record(item), id=track.stateVariableId;
        if(typeof id!=="string" || typeof track.ladder!=="string" || !Object.hasOwn(ladders,track.ladder)) continue;
        const stages=ladders[track.ladder];
        if(!Array.isArray(stages) || stages.length<2 || stages.length>500) continue;
        const labels=stages.map(stage=>record(stage).label);
        if(!labels.every((value):value is string=>typeof value==="string" && value.length>0 && value.length<=1000) || new Set(labels).size!==labels.length) continue;
        if(Object.hasOwn(result,id) && JSON.stringify(result[id])!==JSON.stringify(labels)){conflicts.add(id);continue;}
        result[id]=labels;
      }
    }
  }
  for(const id of conflicts) delete result[id];
  return result;
}
