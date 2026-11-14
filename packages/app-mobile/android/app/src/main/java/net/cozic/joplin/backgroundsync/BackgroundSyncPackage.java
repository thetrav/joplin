package net.cozic.joplin.backgroundsync;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.common.LifecycleState;
import com.facebook.react.jstasks.HeadlessJsTaskConfig;
import com.facebook.react.jstasks.HeadlessJsTaskContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Collections;
import java.util.List;

public class BackgroundSyncPackage implements ReactPackage {

	@NonNull
	@Override
	public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext reactContext) {
		return Collections.singletonList(new BackgroundSyncModule(reactContext));
	}

	@NonNull
	@Override
	public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext reactContext) {
		return Collections.emptyList();
	}

	public static class BackgroundSyncModule extends ReactContextBaseJavaModule implements LifecycleEventListener {
		private static final String TAG = "JoplinBackgroundSync";
		static final String SYNC_IN_PROGRESS_TASK_KEY = "JoplinSyncInProgress";

		// Guarded by the module's lock: React methods and lifecycle callbacks run on different threads
		private boolean syncInProgress = false;
		private boolean foregroundServiceAcquired = false;

		public BackgroundSyncModule(@NonNull ReactApplicationContext context) {
			super(context);
			context.addLifecycleEventListener(this);
		}

		@NonNull
		@Override
		public String getName() {
			return "BackgroundSyncModule";
		}

		// Android 12+ only allows starting a foreground service while the app is visible (not even just after it
		// leaves the screen), so a sync gets one as soon as it's running with the app on screen: when it starts, or
		// when the app is opened during it. The system waits about 10 seconds before showing the notification, so
		// short syncs don't show one.
		@ReactMethod
		public synchronized void syncStarted(String notificationTitle, String channelName) {
			saveNotificationText(notificationTitle, channelName);
			syncInProgress = true;
			if (getReactApplicationContext().getLifecycleState() == LifecycleState.RESUMED) startForegroundSync();
		}

		@ReactMethod
		public synchronized void syncFinished() {
			syncInProgress = false;
			if (!foregroundServiceAcquired) return;
			foregroundServiceAcquired = false;
			BackgroundSyncForegroundService.release(getReactApplicationContext());
		}

		@Override
		public synchronized void onHostResume() {
			if (syncInProgress) startForegroundSync();
		}

		@Override
		public void onHostPause() {}

		@Override
		public void onHostDestroy() {}

		private void startForegroundSync() {
			if (foregroundServiceAcquired) return;

			ReactApplicationContext context = getReactApplicationContext();
			foregroundServiceAcquired = true;
			if (!BackgroundSyncForegroundService.acquire(context)) {
				foregroundServiceAcquired = false;
				BackgroundSyncForegroundService.release(context);
				return;
			}

			// React Native stops JS timers once the app is paused unless a headless task is running, which would
			// stall the sync even though the process is kept alive. The task ends when the sync does.
			UiThreadUtil.runOnUiThread(() -> {
				try {
					HeadlessJsTaskContext.getInstance(context)
						.startTask(new HeadlessJsTaskConfig(SYNC_IN_PROGRESS_TASK_KEY, Arguments.createMap(), 0, true));
				} catch (RuntimeException e) {
					Log.e(TAG, "Could not start sync in progress task", e);
				}
			});
		}

		// The foreground service builds its notification natively, so the translated text is stored for it.
		private void saveNotificationText(String notificationTitle, String channelName) {
			getReactApplicationContext()
				.getSharedPreferences(BackgroundSyncForegroundService.PREFS_NAME, Context.MODE_PRIVATE)
				.edit()
				.putString(BackgroundSyncForegroundService.PREF_NOTIFICATION_TITLE, notificationTitle)
				.putString(BackgroundSyncForegroundService.PREF_CHANNEL_NAME, channelName)
				.apply();
		}
	}
}
