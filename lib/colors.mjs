// Semantic palette keys, shared by actions, saved state and the picker.
export const COLORS = Object.freeze([
  ['red', 'Red', 41], ['peach', 'Peach', 43], ['yellow', 'Yellow', 103],
  ['green', 'Green', 42], ['teal', 'Teal', 46], ['blue', 'Blue', 44],
  ['mauve', 'Mauve', 45], ['gray', 'Gray', 100],
].map(([key, label, ansiBackground]) => Object.freeze({ key, label, ansiBackground })));

export function parseColor(value) {
  if (value === 'none') return null;
  if (COLORS.some(color => color.key === value)) return value;
  throw new Error(`Invalid highlight color; choose none or ${COLORS.map(c => c.key).join(', ')}`);
}

export function colorLabel(value) {
  if (value === null) return 'None';
  const key = parseColor(value);
  return COLORS.find(color => color.key === key).label;
}
