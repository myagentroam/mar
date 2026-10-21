type PlanPart = { kind: 'message' | 'plan'; text: string };

const openTag = '<proposed_plan>';
const closeTag = '</proposed_plan>';

function nextFence(line: string, fence: string | undefined): string | undefined {
  const trimmed = line.trim();
  const marker = /^(`{3,}|~{3,})/u.exec(trimmed)?.[1];
  if (!fence) return marker;
  return marker && marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker
    ? undefined
    : fence;
}

/** Only standalone, unfenced delimiters declare a plan, never prose or examples. */
export function splitPlanOutput(text: string): PlanPart[] {
  const parts: PlanPart[] = [];
  let normal = '';
  let plan: string | undefined;
  let opening = '';
  let fence: string | undefined;
  const flushNormal = () => {
    if (normal) parts.push({ kind: 'message', text: normal });
    normal = '';
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const trimmed = line.trim();
    const previousFence = fence;
    fence = nextFence(line, fence);
    if (!previousFence && !fence && trimmed === openTag && plan === undefined) {
      opening = line;
      plan = '';
      continue;
    } else if (!previousFence && !fence && trimmed === closeTag && plan !== undefined) {
      if (plan.trim()) {
        flushNormal();
        parts.push({ kind: 'plan', text: plan.trim() });
      } else normal += opening + plan + line;
      plan = undefined;
      continue;
    }
    if (plan === undefined) normal += line;
    else plan += line;
  }
  if (plan !== undefined) normal += opening + plan;
  flushNormal();
  return parts;
}

/**
 * Stream ordinary prose immediately. Once a possible plan delimiter starts,
 * defer the remainder until text.completed can establish the complete boundary.
 */
export class PlanOutputPrefix {
  #line = '';
  #pending = '';
  #blocked = false;
  #ordinaryLine = false;
  #fence: string | undefined;

  push(delta: string): string {
    if (this.#blocked) return '';
    let output = '';
    for (const character of delta) {
      this.#line += character;
      if (character === '\n') {
        if (!this.#fence && this.#line.trim() === openTag) {
          this.#blocked = true;
          break;
        }
        output += this.#pending + character;
        this.#fence = nextFence(this.#line, this.#fence);
        this.#pending = '';
        this.#line = '';
        this.#ordinaryLine = false;
        continue;
      }
      if (this.#ordinaryLine) {
        output += character;
        continue;
      }
      this.#pending += character;
      const candidate = this.#line.trim();
      if (this.#fence || !openTag.startsWith(candidate)) {
        output += this.#pending;
        this.#pending = '';
        this.#ordinaryLine = true;
      }
    }
    return output;
  }
}
