import { AppRegistry, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import Setting from '@joplin/lib/models/Setting';
import { reg } from '@joplin/lib/registry';
import ResourceFetcher from '@joplin/lib/services/ResourceFetcher';
import { _ } from '@joplin/lib/locale';
import Logger from '@joplin/utils/Logger';
import checkPermissions from '../../utils/checkPermissions';

const logger = Logger.create('backgroundSync');

// Must match SYNC_IN_PROGRESS_TASK_KEY in BackgroundSyncPackage.java
const syncInProgressTaskName = 'JoplinSyncInProgress';

interface BackgroundSyncNativeModule {
	syncStarted(notificationTitle: string, channelName: string): void;
	syncFinished(): void;
}

const nativeModule: BackgroundSyncNativeModule|null = Platform.OS === 'android' ? NativeModules.BackgroundSyncModule : null;

const isEnabled = () => {
	return Setting.value('sync.backgroundSync') && Setting.value('sync.target') !== 0;
};

// Attachments are downloaded by ResourceFetcher after the sync completes, so a sync isn't finished until it's idle.
// autoAddResources also queues attachments left over from earlier syncs.
const waitForAttachmentDownloads = async () => {
	void ResourceFetcher.instance().autoAddResources();
	await ResourceFetcher.instance().waitForAllFinished();
};

const notificationTitle = () => _('Synchronising...');
const channelName = () => _('Background synchronisation');

// On Android 13+ the foreground service still runs without this permission, but its notification is hidden.
export const requestNotificationPermission = async () => {
	if (!nativeModule) return;
	const response = await checkPermissions(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
	if (response === PermissionsAndroid.RESULTS.DENIED) logger.warn('POST_NOTIFICATIONS permission was not granted');
};

let syncCount = 0;

// Lets a sync started in the app continue if the app is closed or the screen turns off (see
// BackgroundSyncModule.syncStarted)
export const onSyncStarted = () => {
	syncCount++;
	if (!nativeModule || !isEnabled()) return;
	nativeModule.syncStarted(notificationTitle(), channelName());
};

export const onSyncCompleted = async () => {
	if (!nativeModule) return;

	const syncCountAtCompletion = syncCount;
	try {
		if (isEnabled()) {
			logger.info('Sync completed - waiting for attachment downloads');
			await waitForAttachmentDownloads();
		}
	} catch (error) {
		logger.warn('Error while finishing the sync:', error);
	}
	// A sync started while downloading now owns the foreground service.
	if (syncCountAtCompletion === syncCount) nativeModule.syncFinished();
};

export const registerBackgroundSyncTask = () => {
	if (!nativeModule) return;

	// Started natively alongside a sync. While it runs, React Native keeps JS timers running in the background.
	AppRegistry.registerHeadlessTask(syncInProgressTaskName, () => async () => {
		const synchronizer = await reg.syncTarget().synchronizer();
		await synchronizer.waitForSyncToFinish();
		await waitForAttachmentDownloads();
	});
};
