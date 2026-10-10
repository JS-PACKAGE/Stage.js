// `<script type="module" src="https://host/lib/stage-element.js">` is all an embedding page needs.
import { defineStageElement } from './element.ts';

export { StageElement, defineStageElement } from './element.ts';
export * from './index.ts';

defineStageElement();
