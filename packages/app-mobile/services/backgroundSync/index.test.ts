import { setupDatabaseAndSynchronizer, switchClient } from '@joplin/lib/testing/test-utils';
import Setting from '@joplin/lib/models/Setting';
import ResourceFetcher from '@joplin/lib/services/ResourceFetcher';
import { reg } from '@joplin/lib/registry';
import { onSyncCompleted, onSyncStarted, registerBackgroundSyncTask } from './index';
import { AppRegistry, NativeModules } from 'react-native';

type HeadlessTask = ()=> Promise<void>;

jest.mock('react-native', () => {
	const ReactNative = jest.requireActual('react-native');
	const headlessTasks: Record<string, HeadlessTask> = {};
	const overrides: Record<string, unknown> = {
		Platform: { ...ReactNative.Platform, OS: 'android' },
		NativeModules: {
			...ReactNative.NativeModules,
			BackgroundSyncModule: { syncStarted: jest.fn(), syncFinished: jest.fn(), showSyncAlert: jest.fn(), hideSyncAlert: jest.fn() },
		},
		AppRegistry: {
			headlessTasks,
			registerHeadlessTask: (name: string, provider: ()=> HeadlessTask) => { headlessTasks[name] = provider(); },
		},
		DeviceEventEmitter: { addListener: () => ({ remove: () => {} }) },
	};
	return new Proxy(ReactNative, {
		get: (target, property: string) => (property in overrides ? overrides[property] : target[property]),
	});
});

const nativeModule = NativeModules.BackgroundSyncModule as Record<'syncFinished'|'showSyncAlert'|'hideSyncAlert', jest.Mock>;
const headlessTasks = (AppRegistry as unknown as { headlessTasks: Record<string, HeadlessTask> }).headlessTasks;

const runBackgroundSync = () => headlessTasks['JoplinBackgroundSync']();

const setNoteLockConflict = (keyId: string|null) => {
	Setting.setValue('noteLock.conflictNoteLockKey', keyId ? { noteLockKey: { id: keyId }, syncMigrationId: 'migration' } : {});
};

describe('backgroundSync/index', () => {
	beforeAll(() => {
		registerBackgroundSyncTask(async () => {});
	});

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		jest.clearAllMocks();
		Setting.setValue('sync.backgroundSync', true);
		Setting.setValue('sync.interval', 300);
		jest.spyOn(ResourceFetcher.instance(), 'autoAddResources').mockResolvedValue(undefined);
		jest.spyOn(reg, 'syncTarget').mockReturnValue({
			synchronizer: async () => ({ waitForSyncToFinish: async () => {}, cancel: async () => {} }),
		} as unknown as ReturnType<typeof reg.syncTarget>);
		jest.spyOn(reg, 'scheduleSync').mockResolvedValue(undefined);
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

	test('should alert once per conflicting note lock key, and clear the alert once resolved', async () => {
		jest.spyOn(ResourceFetcher.instance(), 'waitForAllFinished').mockResolvedValue(undefined);

		setNoteLockConflict('key1');
		await onSyncCompleted();
		expect(nativeModule.showSyncAlert).not.toHaveBeenCalled();

		await runBackgroundSync();
		await runBackgroundSync();
		expect(nativeModule.showSyncAlert).toHaveBeenCalledTimes(1);

		setNoteLockConflict('key2');
		await runBackgroundSync();
		expect(nativeModule.showSyncAlert).toHaveBeenCalledTimes(2);

		setNoteLockConflict(null);
		await onSyncCompleted();
		await runBackgroundSync();
		expect(nativeModule.hideSyncAlert).toHaveBeenCalledTimes(1);
	});
});
