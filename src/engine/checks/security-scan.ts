export interface ScanFinding {
  file: string;
  line: number;
  rule: string;
  problem: string;
}

const RULES: Array<{ rule: string; pattern: RegExp; problem: string }> = [
  { rule: 'eval', pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*['"`]/, problem: 'runs code from a string' },
  {
    rule: 'raw-html',
    pattern: /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|createContextualFragment\s*\(/,
    problem: 'puts raw HTML on the page',
  },
  { rule: 'cookies', pattern: /document\.cookie|\bcookieStore\b/, problem: 'reads or writes cookies' },
  { rule: 'script-injection', pattern: /createElement\(\s*['"`]script['"`]\s*\)|<script\b|\bimport\(\s*['"`]https?:/, problem: 'adds a script to the page' },
];

const SOURCE = /^app\/.+\.(?:tsx?|jsx?|mjs)$/;

export function securityScan(files: Map<string, Buffer>): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const [file, bytes] of files) {
    if (!SOURCE.test(file)) continue;
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((text, index) => {
      for (const { rule, pattern, problem } of RULES) if (pattern.test(text)) findings.push({ file, line: index + 1, rule, problem });
    });
  }
  return findings;
}
