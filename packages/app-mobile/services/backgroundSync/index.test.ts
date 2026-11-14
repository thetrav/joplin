import { setupDatabaseAndSynchronizer, switchClient } from '@joplin/lib/testing/test-utils';
import Setting from '@joplin/lib/models/Setting';
import ResourceFetcher from '@joplin/lib/services/ResourceFetcher';
import { onSyncCompleted, onSyncStarted } from './index';
import { NativeModules } from 'react-native';

jest.mock('react-native', () => {
	const ReactNative = jest.requireActual('react-native');
	const overrides: Record<string, unknown> = {
		Platform: { ...ReactNative.Platform, OS: 'android' },
		NativeModules: {
			...ReactNative.NativeModules,
			BackgroundSyncModule: { syncStarted: jest.fn(), syncFinished: jest.fn() },
		},
	};
	return new Proxy(ReactNative, {
		get: (target, property: string) => (property in overrides ? overrides[property] : target[property]),
	});
});

const nativeModule = NativeModules.BackgroundSyncModule as Record<'syncFinished', jest.Mock>;

describe('backgroundSync/index', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		jest.clearAllMocks();
		Setting.setValue('sync.backgroundSync', true);
		jest.spyOn(ResourceFetcher.instance(), 'autoAddResources').mockResolvedValue(undefined);
	});

	test.each([
		['a single sync', false, false, 1],
		['a sync started while attachments download', true, false, 0],
		['attachment downloads that fail', false, true, 1],
	])('should release the foreground service unless a newer sync owns it: %s', async (_name, startAnotherSync, downloadsFail, expectedReleases) => {
		let finishDownloads: (error?: Error)=> void;
		const waitingForDownloads = new Promise<void>(waiting => {
			jest.spyOn(ResourceFetcher.instance(), 'waitForAllFinished').mockImplementation(() => {
				waiting();
				return new Promise<void>((resolve, reject) => {
					finishDownloads = (error) => (error ? reject(error) : resolve());
				});
			});
		});

		onSyncStarted();
		const completed = onSyncCompleted();
		if (startAnotherSync) onSyncStarted();
		await waitingForDownloads;
		finishDownloads(downloadsFail ? new Error('Download failed') : undefined);
		await completed;

		expect(nativeModule.syncFinished).toHaveBeenCalledTimes(expectedReleases);
	});
});
