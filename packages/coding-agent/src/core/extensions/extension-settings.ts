import { copyJson } from "@earendil-works/chord";
import type { Static, TSchema } from "typebox";
import { Check, Clone, Equal } from "typebox/value";
import type { SettingsScope } from "../settings-manager.ts";
import type { SourceInfo } from "../source-info.ts";

const SETTING_KEY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PROTOTYPE_SENSITIVE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export interface ExtensionSettingChoice<T> {
	readonly label: string;
	readonly value: T;
}

export interface ExtensionSettingDefinition<TSchemaType extends TSchema> {
	key: string;
	schema: TSchemaType;
	defaultValue: Static<TSchemaType>;
	title: string;
	description: string;
	ui?: {
		control: "select";
		choices: readonly ExtensionSettingChoice<Static<TSchemaType>>[];
	};
}

export interface ExtensionSettingHandle<T> {
	readonly key: string;
	get(): T;
	set(value: T, options?: { scope?: SettingsScope }): void;
	onChange(listener: (value: T) => void): () => void;
}

export interface RegisteredExtensionSetting {
	readonly definition: ExtensionSettingDefinition<TSchema>;
	readonly sourceInfo: SourceInfo;
}

/** Return whether a setting key is flat, namespaced, lowercase, and safe for object-backed storage. */
export function isValidExtensionSettingKey(key: string): boolean {
	if (!SETTING_KEY_PATTERN.test(key) || !key.includes(".")) return false;
	return key.split(/[.-]/).every((segment) => !PROTOTYPE_SENSITIVE_SEGMENTS.has(segment));
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
	}
	return Object.freeze(value);
}

function copySettingValue<T>(key: string, kind: string, value: unknown): T {
	try {
		return copyJson(value) as unknown as T;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Extension setting "${key}" ${kind} must be strict JSON: ${reason}`);
	}
}

/** Validate, defensively clone, and freeze a setting definition for loader-owned registration. */
export function cloneExtensionSettingDefinition<TSchemaType extends TSchema>(
	definition: ExtensionSettingDefinition<TSchemaType>,
): ExtensionSettingDefinition<TSchemaType> {
	if (typeof definition !== "object" || definition === null) {
		throw new Error("Extension setting definition must be an object.");
	}
	const { key } = definition;
	if (typeof key !== "string" || !isValidExtensionSettingKey(key)) {
		throw new Error(
			`Invalid extension setting key "${String(key)}": expected a lowercase namespaced key containing at least one dot.`,
		);
	}
	if (typeof definition.title !== "string" || typeof definition.description !== "string") {
		throw new Error(`Extension setting "${key}" must define string title and description fields.`);
	}

	const defaultValue = copySettingValue<Static<TSchemaType>>(key, "defaultValue", definition.defaultValue);
	if (!Check(definition.schema, defaultValue)) {
		throw new Error(`Extension setting "${key}" defaultValue does not satisfy its schema.`);
	}

	let ui: ExtensionSettingDefinition<TSchemaType>["ui"];
	if (definition.ui !== undefined) {
		if (definition.ui.control !== "select" || !Array.isArray(definition.ui.choices)) {
			throw new Error(`Extension setting "${key}" UI metadata must define a select control with choices.`);
		}
		const labels = new Set<string>();
		const choices: ExtensionSettingChoice<Static<TSchemaType>>[] = [];
		for (const choice of definition.ui.choices) {
			if (typeof choice !== "object" || choice === null || typeof choice.label !== "string") {
				throw new Error(`Extension setting "${key}" UI choices must define string labels.`);
			}
			if (labels.has(choice.label)) {
				throw new Error(`Extension setting "${key}" has duplicate UI choice label "${choice.label}".`);
			}
			labels.add(choice.label);
			const value = copySettingValue<Static<TSchemaType>>(key, `UI choice "${choice.label}"`, choice.value);
			if (!Check(definition.schema, value)) {
				throw new Error(`Extension setting "${key}" UI choice "${choice.label}" does not satisfy its schema.`);
			}
			choices.push({ label: choice.label, value });
		}
		if (!choices.some((choice) => Equal(choice.value, defaultValue))) {
			throw new Error(`Extension setting "${key}" defaultValue must equal one of its UI choices.`);
		}
		ui = { control: "select", choices };
	}

	const schema = Clone(definition.schema);

	return deepFreeze({
		key,
		schema,
		defaultValue,
		title: definition.title,
		description: definition.description,
		...(ui === undefined ? {} : { ui }),
	});
}
