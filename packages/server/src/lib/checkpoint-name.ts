export function nextCheckpointName(checkpoints: ReadonlyArray<{ name: string }>): string {
  const names = new Set(checkpoints.map(checkpoint => checkpoint.name.trim().toLowerCase()));
  let number = 1;
  while (names.has(`checkpoint #${number}`)) number++;
  return `Checkpoint #${number}`;
}
