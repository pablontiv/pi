import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RoutedServerPresentation, RoutedServerServiceAttachment } from "@earendil-works/pi-server";
import { describe, expect, test, vi } from "vitest";
import { PresentationPlugins } from "../src/experimental/services/plugins.ts";
import { createExperimentalServerServices } from "../src/experimental/services/server.ts";

const EMPTY_PRESENTATION_PLUGINS: JsonValue = { presentationFacetBundles: [] };

function presentation(allowLocalFilesystemAccess: boolean): RoutedServerPresentation {
	return {
		allowLocalFilesystemAccess,
		async attachSession() {},
		async detachSession() {},
		async prepareSessionRemoval() {},
	};
}

function call(
	attachment: RoutedServerServiceAttachment,
	member: "prepareSession" | "reload",
	args: readonly JsonValue[],
): Promise<JsonValue | undefined> {
	const serviceCall: ServiceCall = { serviceId: PresentationPlugins.id, member, args };
	return attachment.invokeService(serviceCall, async () => {}, BACKGROUND_CONTEXT);
}

function createServices() {
	const prepareSessionPlugins = vi.fn(async (_sessionId: string, packagePaths: readonly string[] | undefined) => ({
		packagePaths: packagePaths ?? ["/server/existing-plugin"],
		presentationPlugins: EMPTY_PRESENTATION_PLUGINS,
	}));
	const reloadPresentationPlugins = vi.fn(async () => EMPTY_PRESENTATION_PLUGINS);
	return {
		prepareSessionPlugins,
		reloadPresentationPlugins,
		services: createExperimentalServerServices({
			async list() {
				return [];
			},
			async create() {
				throw new Error("Unexpected create");
			},
			async remove() {
				throw new Error("Unexpected remove");
			},
			prepareSessionPlugins,
			reloadPresentationPlugins,
		}),
	};
}

describe("experimental server plugin trust boundary", () => {
	test("rejects remote package selections before plugin operations and preserves the existing selection on reload", async () => {
		const created = createServices();
		const services = await created.services;
		const attachment = await services.host.attachClient(presentation(false), BACKGROUND_CONTEXT);
		try {
			await expect(
				call(attachment, "prepareSession", [{ sessionId: "demo-1", packagePaths: ["/client/chosen-plugin"] }]),
			).rejects.toThrow("Remote clients cannot select server plugin package paths");
			expect(created.prepareSessionPlugins).not.toHaveBeenCalled();
			expect(created.reloadPresentationPlugins).not.toHaveBeenCalled();

			await expect(
				call(attachment, "prepareSession", [{ sessionId: "demo-1", packagePaths: null }]),
			).resolves.toEqual(EMPTY_PRESENTATION_PLUGINS);
			expect(created.prepareSessionPlugins).toHaveBeenCalledWith("demo-1", undefined, expect.anything());

			await expect(
				call(attachment, "prepareSession", [{ sessionId: "demo-1", packagePaths: ["/client/reload-plugin"] }]),
			).rejects.toThrow("Remote clients cannot select server plugin package paths");
			await expect(call(attachment, "reload", [])).resolves.toEqual(EMPTY_PRESENTATION_PLUGINS);
			expect(created.reloadPresentationPlugins).toHaveBeenCalledWith(["/server/existing-plugin"], expect.anything());
		} finally {
			await attachment.release(BACKGROUND_CONTEXT);
			await services.dispose();
		}
	});

	test("allows local Unix clients to select package paths", async () => {
		const created = createServices();
		const services = await created.services;
		const attachment = await services.host.attachClient(presentation(true), BACKGROUND_CONTEXT);
		try {
			await expect(
				call(attachment, "prepareSession", [{ sessionId: "demo-1", packagePaths: ["/local/plugin"] }]),
			).resolves.toEqual(EMPTY_PRESENTATION_PLUGINS);
			expect(created.prepareSessionPlugins).toHaveBeenCalledWith("demo-1", ["/local/plugin"], expect.anything());
			await call(attachment, "reload", []);
			expect(created.reloadPresentationPlugins).toHaveBeenCalledWith(["/local/plugin"], expect.anything());
		} finally {
			await attachment.release(BACKGROUND_CONTEXT);
			await services.dispose();
		}
	});
});
