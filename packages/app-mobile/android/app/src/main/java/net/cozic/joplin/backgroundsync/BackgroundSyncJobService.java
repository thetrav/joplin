package net.cozic.joplin.backgroundsync;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.util.Log;

import com.facebook.react.ReactApplication;
import com.facebook.react.ReactHost;
import com.facebook.react.ReactInstanceEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.common.LifecycleState;
import com.facebook.react.jstasks.HeadlessJsTaskConfig;
import com.facebook.react.jstasks.HeadlessJsTaskContext;
import com.facebook.react.jstasks.HeadlessJsTaskEventListener;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

// Runs on the main thread, as required by HeadlessJsTaskContext.
public class BackgroundSyncJobService extends JobService {
	private static final String TAG = "JoplinBackgroundSync";
	static final String TASK_KEY = "JoplinBackgroundSync";
	static final String STOPPED_EVENT = "JoplinBackgroundSyncStopped";

	// A stopped job releases the foreground service straight away and again when its JS task finishes, and must
	// only release it once, or it would release a hold taken by a sync running in the app.
	private final Set<Integer> jobsHoldingService = ConcurrentHashMap.newKeySet();
	// Jobs waiting for React Native to start. A job stopped meanwhile is removed, so its sync never starts.
	private final Map<Integer, ReactInstanceEventListener> jobsWaitingForReact = new ConcurrentHashMap<>();

	@Override
	public boolean onStartJob(JobParameters params) {
		ReactHost host = getReactHost();
		ReactContext current = host.getCurrentReactContext();
		if (current != null) {
			startSyncTask(current, params);
			return true;
		}

		ReactInstanceEventListener listener = new ReactInstanceEventListener() {
			@Override
			public void onReactContextInitialized(ReactContext context) {
				host.removeReactInstanceEventListener(this);
				if (jobsWaitingForReact.remove(params.getJobId()) == null) return;
				startSyncTask(context, params);
			}
		};
		jobsWaitingForReact.put(params.getJobId(), listener);
		host.addReactInstanceEventListener(listener);
		host.start();
		return true;
	}

	@Override
	public boolean onStopJob(JobParameters params) {
		// Android is reclaiming the job (constraints lost or time limit reached). Ask JS to cancel the sync
		// cleanly; the sync context is saved per page, so the next run resumes where this one stopped.
		ReactInstanceEventListener waiting = jobsWaitingForReact.remove(params.getJobId());
		if (waiting != null) getReactHost().removeReactInstanceEventListener(waiting);

		ReactContext reactContext = getReactHost().getCurrentReactContext();
		if (reactContext != null && reactContext.hasActiveReactInstance()) {
			reactContext.emitDeviceEvent(STOPPED_EVENT);
		}
		releaseService(params);
		return true;
	}

	private ReactHost getReactHost() {
		return ((ReactApplication) getApplication()).getReactHost();
	}

	private void startSyncTask(ReactContext reactContext, JobParameters params) {
		// The app's own recurrent sync handles this case.
		if (reactContext.getLifecycleState() == LifecycleState.RESUMED) {
			jobFinished(params, false);
			return;
		}

		BackgroundSyncForegroundService.acquire(this);
		jobsHoldingService.add(params.getJobId());

		HeadlessJsTaskContext headlessContext = HeadlessJsTaskContext.getInstance(reactContext);
		int[] taskId = { -1 };
		HeadlessJsTaskEventListener listener = new HeadlessJsTaskEventListener() {
			@Override
			public void onHeadlessJsTaskStart(int id) {}

			@Override
			public void onHeadlessJsTaskFinish(int id) {
				if (id != taskId[0]) return;
				headlessContext.removeTaskEventListener(this);
				releaseService(params);
				jobFinished(params, false);
			}
		};
		headlessContext.addTaskEventListener(listener);

		try {
			taskId[0] = headlessContext.startTask(new HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), 0, true));
		} catch (RuntimeException e) {
			Log.e(TAG, "Could not start background sync task", e);
			headlessContext.removeTaskEventListener(listener);
			releaseService(params);
			jobFinished(params, false);
		}
	}

	private void releaseService(JobParameters params) {
		if (jobsHoldingService.remove(params.getJobId())) BackgroundSyncForegroundService.release(this);
	}
}
