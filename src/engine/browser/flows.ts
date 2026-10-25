import { z } from 'zod';
import { DriverError, type FlowTarget, PageDriver } from './page-driver';
import type { OutlineNode } from './page-outline';

const target = z.object({ role: z.string().max(40).optional(), name: z.string().max(200).optional(), within: z.string().max(200).optional(), nth: z.number().int().min(0).max(200).optional() });

export const flowStepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('open'), path: z.string().max(300) }),
  z.object({ do: z.literal('click'), target }),
  z.object({ do: z.literal('fill'), target, value: z.string().max(500) }),
  z.object({ do: z.literal('select'), label: z.string().max(200), value: z.string().max(200) }),
  z.object({ do: z.literal('press'), key: z.string().max(40) }),
  z.object({ do: z.literal('wait'), text: z.string().max(200), gone: z.boolean().optional() }),
  z.object({ do: z.literal('scroll'), direction: z.enum(['up', 'down', 'bottom']) }),
  z.object({ do: z.literal('back') }),
]);

export const flowSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), device: z.enum(['phone', 'desktop']), steps: z.array(flowStepSchema).min(1).max(40) });

export type FlowStep = z.infer<typeof flowStepSchema>;
export type Flow = z.infer<typeof flowSchema>;

const CATALOG = /^\/(products|collections)\//;

export function stableTarget(node: OutlineNode, all: OutlineNode[]): FlowTarget {
  if (node.role === 'link' && node.url && CATALOG.test(node.url) && node.context.length) {
    const within = node.context[node.context.length - 1];
    const pool = all.filter(candidate => candidate.role === 'link' && candidate.context.includes(within));
    const nth = pool.findIndex(candidate => candidate.ref === node.ref);
    if (nth >= 0) return { role: 'link', within, nth };
  }
  return { role: node.role, name: node.name };
}

export function describeTarget(target: FlowTarget): string {
  if (target.nth !== undefined) return `${target.role ?? 'link'} number ${target.nth + 1} in "${target.within}"`;
  return `${target.role ?? 'element'} "${target.name}"`;
}

export interface FlowRun {
  passed: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  failedAt: number | null;
}

export async function runFlow(driver: PageDriver, flow: Flow): Promise<FlowRun> {
  const steps: FlowRun['steps'] = [];
  for (const [index, step] of flow.steps.entries()) {
    const label = step.do === 'open' ? `open ${step.path}` : step.do === 'click' || step.do === 'fill' ? `${step.do} ${describeTarget(step.target)}` : step.do === 'select' ? `select "${step.label}" ${step.value}` : step.do === 'press' ? `press ${step.key}` : step.do === 'wait' ? `wait "${step.text}"` : step.do === 'scroll' ? `scroll ${step.direction}` : 'back';
    try {
      if (step.do === 'open') await driver.open(step.path);
      else if (step.do === 'press') await driver.press(step.key);
      else if (step.do === 'wait') await driver.wait(step.text, step.gone ?? false);
      else if (step.do === 'scroll') await (step.direction === 'bottom' ? driver.scrollToBottom() : driver.scroll(step.direction));
      else if (step.do === 'back') await driver.back();
      else {
        const outline = await driver.outline();
        if (step.do === 'select') await driver.select(outline, step.label, step.value);
        else {
          const { node, locator } = driver.resolveFlowTarget(outline, step.target);
          if (step.do === 'click') await driver.click(locator, node);
          else await driver.fill(locator, node, step.value);
        }
      }
      await driver.settle();
      steps.push({ step: label, ok: true });
    } catch (error) {
      steps.push({ step: label, ok: false, detail: error instanceof DriverError ? error.message : String(error) });
      return { passed: false, steps, failedAt: index };
    }
  }
  return { passed: true, steps, failedAt: null };
}
