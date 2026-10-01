import { copyJson } from "@earendil-works/chord";
import type { Static, TSchema } from "typebox";
import { Check, Clone, Equal } from "typebox/value";
import type { ResourceDiagnostic } from "../diagnostics.ts";
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

export interface ExtensionSettingsActions {
	getExtensionSettingLayers(key: string): { global: unknown; project: unknown };
	setExtensionSetting(key: string, value: unknown, scope: SettingsScope): void;
}

export interface ExtensionSettingRegistrationSource {
	readonly extensionPath: string;
	readonly registration: RegisteredExtensionSetting;
}

export interface ExtensionSettingRuntimeError {
	readonly extensionPath: string;
	readonly event: "extension_setting";
	readonly error: string;
}

/** Runtime registry for extension-owned settings. It contains no presentation components. */
export class ExtensionSettingsRegistry {
	private readonly registrations = new Map<string, ExtensionSettingRegistrationSource>();
	private readonly descriptors: readonly RegisteredExtensionSetting[];
	private readonly diagnostics: ResourceDiagnostic[] = [];
	private readonly reportedDiagnostics = new Set<string>();
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private readonly actions: ExtensionSettingsActions;
	private readonly reportError: (error: ExtensionSettingRuntimeError) => void;

	constructor(
		sources: readonly {
			readonly path: string;
			readonly settings?: ReadonlyMap<string, RegisteredExtensionSetting>;
		}[],
		actions: ExtensionSettingsActions,
		reportError: (error: ExtensionSettingRuntimeError) => void,
	) {
		this.actions = actions;
		this.reportError = reportError;
		for (const source of sources) {
			for (const [key, registration] of source.settings ?? []) {
				const winner = this.registrations.get(key);
				if (winner !== undefined) {
					this.addDiagnostic(
						`collision:${key}:${source.path}`,
						source.path,
						`Extension setting "${key}" is registered by both "${winner.extensionPath}" and "${source.path}". Using "${winner.extensionPath}".`,
					);
					continue;
				}
				const sourceInfo = Object.freeze({ ...registration.sourceInfo });
				this.registrations.set(key, {
					extensionPath: source.path,
					registration: Object.freeze({ definition: registration.definition, sourceInfo }),
				});
			}
		}
		this.descriptors = Object.freeze(Array.from(this.registrations.values(), ({ registration }) => registration));

		// Validate at construction so diagnostics are deterministic even when no handle calls get().
		for (const entry of this.registrations.values()) this.resolve(entry);
	}

	getRegisteredSettings(): readonly RegisteredExtensionSetting[] {
		return this.descriptors;
	}

	getDiagnostics(): readonly ResourceDiagnostic[] {
		return Object.freeze(this.diagnostics.slice());
	}

	get(extensionPath: string, key: string): unknown {
		const entry = this.requireOwner(extensionPath, key);
		return copySettingValue(key, "value", this.resolve(entry));
	}

	set(extensionPath: string, key: string, value: unknown, scope: SettingsScope): void {
		const entry = this.requireOwner(extensionPath, key);
		if (scope !== "global" && scope !== "project") {
			throw new Error(`Invalid scope for extension setting "${key}": ${String(scope)}`);
		}
		const copiedValue = copySettingValue(key, "value", value);
		if (!checkSettingValue(key, entry.registration.definition.schema, copiedValue)) {
			throw new Error(`Extension setting "${key}" value does not satisfy its schema.`);
		}

		const previous = this.resolve(entry);
		this.actions.setExtensionSetting(key, copiedValue, scope);
		const next = this.resolve(entry);
		if (Equal(previous, next)) return;

		for (const listener of this.listeners.get(key) ?? []) {
			try {
				listener(copySettingValue(key, "value", next));
			} catch (error) {
				this.reportError({
					extensionPath,
					event: "extension_setting",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	onChange(extensionPath: string, key: string, listener: (value: unknown) => void): () => void {
		this.requireOwner(extensionPath, key);
		const listeners = this.listeners.get(key) ?? new Set<(value: unknown) => void>();
		listeners.add(listener);
		this.listeners.set(key, listeners);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	}

	setValue(key: string, value: unknown): void {
		const entry = this.registrations.get(key);
		if (entry === undefined) throw new Error(`Extension setting "${key}" is not registered.`);
		this.set(entry.extensionPath, key, value, "global");
	}

	clearListeners(): void {
		this.listeners.clear();
	}

	private requireOwner(extensionPath: string, key: string): ExtensionSettingRegistrationSource {
		const entry = this.registrations.get(key);
		if (entry === undefined) throw new Error(`Extension setting "${key}" is not registered.`);
		if (entry.extensionPath !== extensionPath) {
			throw new Error(
				`Extension setting "${key}" is owned by "${entry.extensionPath}"; "${extensionPath}" cannot access it.`,
			);
		}
		return entry;
	}

	private resolve(entry: ExtensionSettingRegistrationSource): unknown {
		const { definition } = entry.registration;
		let layers: { global: unknown; project: unknown };
		try {
			layers = this.actions.getExtensionSettingLayers(definition.key);
		} catch (error) {
			this.addDiagnostic(
				`read:${definition.key}`,
				entry.extensionPath,
				`Could not read stored extension setting "${definition.key}": ${error instanceof Error ? error.message : String(error)}`,
			);
			return copySettingValue(definition.key, "defaultValue", definition.defaultValue);
		}
		const project = this.validateLayer(entry, "project", layers.project);
		const global = this.validateLayer(entry, "global", layers.global);
		if (project.valid) return project.value;
		if (global.valid) return global.value;
		return copySettingValue(definition.key, "defaultValue", definition.defaultValue);
	}

	private validateLayer(
		entry: ExtensionSettingRegistrationSource,
		layer: SettingsScope,
		value: unknown,
	): { valid: false } | { valid: true; value: unknown } {
		if (value === undefined) return { valid: false };
		const { definition } = entry.registration;
		let copiedValue: unknown;
		try {
			copiedValue = copySettingValue(definition.key, `${layer} value`, value);
		} catch (error) {
			this.addInvalidLayerDiagnostic(entry, layer, error instanceof Error ? error.message : String(error));
			return { valid: false };
		}
		if (!checkSettingValue(definition.key, definition.schema, copiedValue)) {
			this.addInvalidLayerDiagnostic(entry, layer, "value does not satisfy its schema");
			return { valid: false };
		}
		return { valid: true, value: copiedValue };
	}

	private addInvalidLayerDiagnostic(
		entry: ExtensionSettingRegistrationSource,
		layer: SettingsScope,
		reason: string,
	): void {
		const key = entry.registration.definition.key;
		this.addDiagnostic(
			`invalid:${key}:${layer}`,
			entry.extensionPath,
			`Ignoring invalid ${layer} value for extension setting "${key}": ${reason}.`,
		);
	}

	private addDiagnostic(id: string, extensionPath: string, message: string): void {
		if (this.reportedDiagnostics.has(id)) return;
		this.reportedDiagnostics.add(id);
		this.diagnostics.push(Object.freeze({ type: "warning", message, path: extensionPath }));
		this.reportError({ extensionPath, event: "extension_setting", error: message });
	}
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

function invalidSchemaError(key: string, cause: unknown): Error {
	return new Error(`Extension setting "${key}" has an invalid TypeBox schema.`, { cause });
}

function cloneSettingSchema<TSchemaType extends TSchema>(key: string, schema: unknown): TSchemaType {
	try {
		if (
			typeof schema !== "object" ||
			schema === null ||
			Array.isArray(schema) ||
			(!Object.hasOwn(schema, "~kind") && !Object.hasOwn(schema, "~unsafe"))
		) {
			throw new TypeError("Expected a TypeBox schema object");
		}
		return Clone(schema) as TSchemaType;
	} catch (cause) {
		throw invalidSchemaError(key, cause);
	}
}

function checkSettingValue(key: string, schema: TSchema, value: unknown): boolean {
	try {
		return Check(schema, value);
	} catch (cause) {
		throw invalidSchemaError(key, cause);
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

	const schema = deepFreeze(cloneSettingSchema<TSchemaType>(key, definition.schema));
	const defaultValue = copySettingValue<Static<TSchemaType>>(key, "defaultValue", definition.defaultValue);
	if (!checkSettingValue(key, schema, defaultValue)) {
		throw new Error(`Extension setting "${key}" defaultValue does not satisfy its schema.`);
	}

	let ui: ExtensionSettingDefinition<TSchemaType>["ui"];
	if (definition.ui !== undefined) {
		if (
			typeof definition.ui !== "object" ||
			definition.ui === null ||
			definition.ui.control !== "select" ||
			!Array.isArray(definition.ui.choices)
		) {
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
			if (!checkSettingValue(key, schema, value)) {
				throw new Error(`Extension setting "${key}" UI choice "${choice.label}" does not satisfy its schema.`);
			}
			choices.push({ label: choice.label, value });
		}
		if (!choices.some((choice) => Equal(choice.value, defaultValue))) {
			throw new Error(`Extension setting "${key}" defaultValue must equal one of its UI choices.`);
		}
		ui = { control: "select", choices };
	}

	return deepFreeze({
		key,
		schema,
		defaultValue,
		title: definition.title,
		description: definition.description,
		...(ui === undefined ? {} : { ui }),
	});
}
