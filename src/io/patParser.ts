// Parser für AutoCAD .pat Schraffur-Musterdateien.
// Liefert strukturierte Linienfamilien zur späteren Übernahme in die Hatch-Bibliothek.

export interface PatLineFamily {
  angle: number; // Grad
  x: number;
  y: number; // Ursprung
  dx: number;
  dy: number; // Verschiebung entlang / senkrecht
  dashes: number[]; // ggf. leer (durchgezogene Familie)
}

export interface PatPattern {
  name: string;
  description: string;
  families: PatLineFamily[];
}

// Zerlegt eine Familienzeile in numerische Tokens.
function parseNumbers(line: string): number[] {
  const tokens = line.split(',');
  const numbers: number[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === '') continue;
    const value = Number(token);
    numbers.push(value);
  }
  return numbers;
}

export function parsePat(text: string): PatPattern[] {
  const result: PatPattern[] = [];
  // CRLF/CR vereinheitlichen.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let current: PatPattern | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith(';')) continue;

    if (line.startsWith('*')) {
      // Header: *PATTERNNAME, optional description
      const body = line.slice(1);
      const commaIndex = body.indexOf(',');
      const name = (commaIndex >= 0 ? body.slice(0, commaIndex) : body).trim();
      const description = commaIndex >= 0 ? body.slice(commaIndex + 1).trim() : '';
      current = { name, description, families: [] };
      result.push(current);
      continue;
    }

    // Familienzeile nur gültig innerhalb eines Pattern-Blocks.
    if (!current) continue;

    const numbers = parseNumbers(line);
    // Mindestens angle, x, y, dx, dy erforderlich.
    if (numbers.length < 5) continue;
    if (!numbers.slice(0, 5).every((n) => Number.isFinite(n))) continue;

    const [angle, x, y, dx, dy] = numbers;
    const dashes: number[] = [];
    for (let k = 5; k < numbers.length; k++) {
      if (Number.isFinite(numbers[k])) {
        dashes.push(numbers[k]);
      }
    }

    current.families.push({ angle, x, y, dx, dy, dashes });
  }

  return result;
}
