//! Native desktop update policy.
//!
//! The renderer only sees [`UpdateSnapshot`] values and invokes the commands at
//! the bottom of this module. GitHub access, target selection, signature
//! verification, single-flight guards and installation stay in this module.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::daemon_runtime::DaemonRuntime;

pub const UPDATE_STATUS_EVENT: &str = "omnicross://update-status";
pub const RELEASE_PAGE: &str = "https://github.com/Dumoedss/omnicross/releases/latest";
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

pub(crate) type BackendFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, BackendError>> + Send + 'static>>;
pub(crate) type ProgressCallback = Arc<dyn Fn(u64, Option<u64>) + Send + Sync + 'static>;
pub(crate) type Publisher = Arc<dyn Fn(UpdateSnapshot) + Send + Sync + 'static>;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Installing,
    Failed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Check,
    Download,
    Install,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateErrorView {
    pub phase: UpdatePhase,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub state: UpdateState,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_percent: Option<f64>,
    pub auto_download_updates: bool,
    pub can_install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<UpdateErrorView>,
}

impl UpdateSnapshot {
    fn initial(current_version: String, auto_download_updates: bool) -> Self {
        Self {
            state: UpdateState::Idle,
            current_version,
            latest_version: None,
            release_notes: None,
            release_url: None,
            downloaded_bytes: None,
            total_bytes: None,
            progress_percent: None,
            auto_download_updates,
            can_install: false,
            error: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckPolicy {
    Silent,
    Interactive,
}

#[derive(Clone, Debug)]
pub(crate) struct CandidateMetadata {
    version: String,
    notes: Option<String>,
    release_url: String,
    can_install: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendErrorKind {
    Unsupported,
    Network,
    Download,
    Install,
}

#[derive(Clone, Debug)]
pub(crate) struct BackendError {
    kind: BackendErrorKind,
    message: &'static str,
}

impl BackendError {
    fn unsupported() -> Self {
        Self {
            kind: BackendErrorKind::Unsupported,
            message: "In-app updates are unavailable for this build.",
        }
    }

    fn network() -> Self {
        Self {
            kind: BackendErrorKind::Network,
            message: "The update service could not be reached.",
        }
    }

    fn download() -> Self {
        Self {
            kind: BackendErrorKind::Download,
            message: "The update could not be downloaded or verified.",
        }
    }

    fn install() -> Self {
        Self {
            kind: BackendErrorKind::Install,
            message: "The verified update could not be installed.",
        }
    }
}

pub(crate) trait UpdateBackend: Send + Sync + 'static {
    type Candidate: Send + 'static;

    fn check(&self) -> BackendFuture<Option<Self::Candidate>>;
    fn metadata(&self, candidate: &Self::Candidate) -> CandidateMetadata;
    fn download(
        &self,
        candidate: Self::Candidate,
        progress: ProgressCallback,
    ) -> BackendFuture<(Self::Candidate, Vec<u8>)>;
    fn install(&self, candidate: Self::Candidate, bytes: Vec<u8>) -> Result<(), BackendError>;
}

pub struct TauriUpdateBackend {
    app: AppHandle,
}

impl TauriUpdateBackend {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

fn classify_updater_check_error(error: UpdaterError) -> BackendError {
    match error {
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => {
            BackendError::unsupported()
        }
        _ => BackendError::network(),
    }
}

fn supported_update_target() -> Option<&'static str> {
    use tauri::utils::config::BundleType;
    use tauri::utils::platform::bundle_type;

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    if bundle_type() == Some(BundleType::Nsis) {
        return Some("windows-x86_64");
    }
    #[cfg(target_os = "macos")]
    if bundle_type() == Some(BundleType::App) {
        return Some("darwin-universal");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    if bundle_type() == Some(BundleType::AppImage) {
        return Some("linux-x86_64");
    }
    None
}

impl UpdateBackend for TauriUpdateBackend {
    type Candidate = Update;

    fn check(&self) -> BackendFuture<Option<Self::Candidate>> {
        if cfg!(debug_assertions) {
            return Box::pin(async { Err(BackendError::unsupported()) });
        }
        let Some(target) = supported_update_target() else {
            return Box::pin(async { Err(BackendError::unsupported()) });
        };
        let app = self.app.clone();
        Box::pin(async move {
            let before_exit = app.clone();
            let updater = app
                .updater_builder()
                .target(target)
                .timeout(CHECK_TIMEOUT)
                .version_comparator(|current, remote| {
                    remote.version.pre.is_empty() && remote.version > current
                })
                .on_before_exit(move || {
                    before_exit.state::<DaemonRuntime>().shutdown();
                    before_exit.cleanup_before_exit();
                })
                .build()
                .map_err(|_| BackendError::network())?;
            updater.check().await.map_err(classify_updater_check_error)
        })
    }

    fn metadata(&self, candidate: &Self::Candidate) -> CandidateMetadata {
        CandidateMetadata {
            version: candidate.version.clone(),
            notes: candidate.body.clone(),
            release_url: format!(
                "https://github.com/Dumoedss/omnicross/releases/tag/v{}",
                candidate.version
            ),
            can_install: true,
        }
    }

    fn download(
        &self,
        candidate: Self::Candidate,
        progress: ProgressCallback,
    ) -> BackendFuture<(Self::Candidate, Vec<u8>)> {
        Box::pin(async move {
            let mut downloaded = 0_u64;
            let bytes = candidate
                .download(
                    move |chunk, total| {
                        downloaded = downloaded.saturating_add(chunk as u64);
                        progress(downloaded, total);
                    },
                    || {},
                )
                .await
                .map_err(|_| BackendError::download())?;
            Ok((candidate, bytes))
        })
    }

    fn install(&self, candidate: Self::Candidate, bytes: Vec<u8>) -> Result<(), BackendError> {
        candidate
            .install(&bytes)
            .map_err(|_| BackendError::install())?;
        #[cfg(not(target_os = "windows"))]
        {
            self.app.state::<DaemonRuntime>().shutdown();
            self.app.restart();
        }
        #[allow(unreachable_code)]
        Ok(())
    }
}

struct UpdateInner<C> {
    snapshot: UpdateSnapshot,
    candidate: Option<C>,
    bytes: Option<Vec<u8>>,
    check_in_flight: bool,
    download_in_flight: bool,
    installing: bool,
    auto_downloaded_version: Option<String>,
}

pub struct UpdateManager<B: UpdateBackend> {
    backend: Arc<B>,
    inner: Arc<Mutex<UpdateInner<B::Candidate>>>,
    publish: Publisher,
    check_timeout: Duration,
}

impl<B: UpdateBackend> Clone for UpdateManager<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            inner: self.inner.clone(),
            publish: self.publish.clone(),
            check_timeout: self.check_timeout,
        }
    }
}

impl<B: UpdateBackend> UpdateManager<B> {
    fn new(
        backend: B,
        current_version: String,
        auto_download_updates: bool,
        publish: Publisher,
    ) -> Self {
        Self {
            backend: Arc::new(backend),
            inner: Arc::new(Mutex::new(UpdateInner {
                snapshot: UpdateSnapshot::initial(current_version, auto_download_updates),
                candidate: None,
                bytes: None,
                check_in_flight: false,
                download_in_flight: false,
                installing: false,
                auto_downloaded_version: None,
            })),
            publish,
            check_timeout: CHECK_TIMEOUT,
        }
    }

    pub fn snapshot(&self) -> UpdateSnapshot {
        self.inner
            .lock()
            .expect("update manager poisoned")
            .snapshot
            .clone()
    }

    fn publish(&self, snapshot: UpdateSnapshot) {
        (self.publish)(snapshot);
    }

    pub fn preference_changed(&self, enabled: bool) -> bool {
        let (snapshot, should_download) = {
            let mut inner = self.inner.lock().expect("update manager poisoned");
            inner.snapshot.auto_download_updates = enabled;
            let should_download = enabled
                && inner.snapshot.state == UpdateState::Available
                && !inner.download_in_flight
                && inner
                    .snapshot
                    .latest_version
                    .as_ref()
                    .is_some_and(|v| inner.auto_downloaded_version.as_ref() != Some(v));
            (inner.snapshot.clone(), should_download)
        };
        self.publish(snapshot);
        should_download
    }

    pub fn clear_pending(&self) {
        let mut inner = self.inner.lock().expect("update manager poisoned");
        inner.candidate = None;
        inner.bytes = None;
        inner.download_in_flight = false;
        inner.installing = false;
    }

    pub async fn check(&self, policy: CheckPolicy) -> UpdateSnapshot {
        let checking = {
            let mut inner = self.inner.lock().expect("update manager poisoned");
            if inner.check_in_flight
                || inner.download_in_flight
                || inner.installing
                || matches!(
                    inner.snapshot.state,
                    UpdateState::Available | UpdateState::Ready
                )
            {
                return inner.snapshot.clone();
            }
            inner.check_in_flight = true;
            inner.snapshot.state = UpdateState::Checking;
            inner.snapshot.error = None;
            inner.snapshot.clone()
        };
        self.publish(checking);

        let result = tokio::time::timeout(self.check_timeout, self.backend.check()).await;
        let mut should_auto_download = false;
        let snapshot = {
            let mut inner = self.inner.lock().expect("update manager poisoned");
            inner.check_in_flight = false;
            match result {
                Err(_) => apply_check_error(&mut inner, policy, BackendError::network()),
                Ok(Err(err)) => apply_check_error(&mut inner, policy, err),
                Ok(Ok(None)) => {
                    inner.candidate = None;
                    inner.bytes = None;
                    inner.snapshot.state = UpdateState::UpToDate;
                    inner.snapshot.latest_version = None;
                    inner.snapshot.release_notes = None;
                    inner.snapshot.release_url = None;
                    inner.snapshot.can_install = false;
                    inner.snapshot.error = None;
                }
                Ok(Ok(Some(candidate))) => {
                    let metadata = self.backend.metadata(&candidate);
                    match accepts_upgrade(&inner.snapshot.current_version, &metadata.version) {
                        Ok(true) => {
                            inner.snapshot.state = UpdateState::Available;
                            inner.snapshot.latest_version = Some(metadata.version.clone());
                            inner.snapshot.release_notes = metadata.notes;
                            inner.snapshot.release_url = Some(metadata.release_url);
                            inner.snapshot.can_install = metadata.can_install;
                            inner.snapshot.downloaded_bytes = None;
                            inner.snapshot.total_bytes = None;
                            inner.snapshot.progress_percent = None;
                            inner.snapshot.error = None;
                            inner.candidate = Some(candidate);
                            should_auto_download = inner.snapshot.auto_download_updates
                                && metadata.can_install
                                && inner.auto_downloaded_version.as_ref()
                                    != Some(&metadata.version);
                        }
                        _ => {
                            inner.candidate = None;
                            inner.bytes = None;
                            inner.snapshot.state = UpdateState::UpToDate;
                            inner.snapshot.latest_version = None;
                            inner.snapshot.release_notes = None;
                            inner.snapshot.release_url = None;
                            inner.snapshot.can_install = false;
                            inner.snapshot.error = None;
                        }
                    }
                }
            }
            inner.snapshot.clone()
        };
        self.publish(snapshot.clone());
        if should_auto_download {
            return self.download_automatically().await;
        }
        snapshot
    }

    pub async fn download(&self) -> UpdateSnapshot {
        self.download_inner(false).await
    }

    pub(crate) async fn download_automatically(&self) -> UpdateSnapshot {
        self.download_inner(true).await
    }

    async fn download_inner(&self, automatic: bool) -> UpdateSnapshot {
        let (candidate, version, downloading) = {
            let mut inner = self.inner.lock().expect("update manager poisoned");
            if inner.download_in_flight
                || inner.installing
                || inner.snapshot.state == UpdateState::Ready
                || !inner.snapshot.can_install
                || (automatic && !inner.snapshot.auto_download_updates)
            {
                return inner.snapshot.clone();
            }
            let Some(candidate) = inner.candidate.take() else {
                return inner.snapshot.clone();
            };
            let version = inner.snapshot.latest_version.clone().unwrap_or_default();
            inner.download_in_flight = true;
            inner.auto_downloaded_version = Some(version.clone());
            inner.bytes = None;
            inner.snapshot.state = UpdateState::Downloading;
            inner.snapshot.can_install = false;
            inner.snapshot.downloaded_bytes = Some(0);
            inner.snapshot.total_bytes = None;
            inner.snapshot.progress_percent = Some(0.0);
            inner.snapshot.error = None;
            (candidate, version, inner.snapshot.clone())
        };
        self.publish(downloading);

        let shared = self.inner.clone();
        let publisher = self.publish.clone();
        let last_emit = Arc::new(Mutex::new(None::<Instant>));
        let progress: ProgressCallback = Arc::new(move |downloaded, total| {
            let now = Instant::now();
            let final_chunk = total.is_some_and(|value| downloaded >= value);
            let should_emit = {
                let mut last = last_emit.lock().expect("progress clock poisoned");
                if final_chunk
                    || last
                        .map(|then| now.duration_since(then) >= PROGRESS_INTERVAL)
                        .unwrap_or(true)
                {
                    *last = Some(now);
                    true
                } else {
                    false
                }
            };
            if !should_emit {
                return;
            }
            let snapshot = {
                let mut inner = shared.lock().expect("update manager poisoned");
                inner.snapshot.downloaded_bytes = Some(downloaded);
                inner.snapshot.total_bytes = total;
                inner.snapshot.progress_percent = total
                    .filter(|value| *value > 0)
                    .map(|value| (downloaded as f64 / value as f64 * 100.0).min(100.0));
                inner.snapshot.clone()
            };
            publisher(snapshot);
        });

        let result = self.backend.download(candidate, progress).await;
        let snapshot = {
            let mut inner = self.inner.lock().expect("update manager poisoned");
            inner.download_in_flight = false;
            match result {
                Ok((candidate, bytes)) => {
                    inner.candidate = Some(candidate);
                    inner.snapshot.state = UpdateState::Ready;
                    inner.snapshot.downloaded_bytes = Some(bytes.len() as u64);
                    if inner.snapshot.total_bytes.is_none() {
                        inner.snapshot.total_bytes = Some(bytes.len() as u64);
                    }
                    inner.snapshot.progress_percent = Some(100.0);
                    inner.snapshot.can_install = true;
                    inner.snapshot.error = None;
                    inner.bytes = Some(bytes);
                }
                Err(err) => {
                    inner.candidate = None;
                    inner.bytes = None;
                    inner.snapshot.state = UpdateState::Failed;
                    inner.snapshot.can_install = false;
                    inner.snapshot.error = Some(UpdateErrorView {
                        phase: UpdatePhase::Download,
                        message: err.message.to_string(),
                        retryable: true,
                    });
                    // A retry first checks again to obtain a fresh plugin handle.
                    inner.auto_downloaded_version = None;
                }
            }
            inner.snapshot.latest_version = Some(version);
            inner.snapshot.clone()
        };
        self.publish(snapshot.clone());
        snapshot
    }

    pub fn install(&self) -> Result<UpdateSnapshot, String> {
        let (candidate, bytes, installing) = {
            let mut inner = self.inner.lock().expect("update manager poisoned");
            if inner.installing {
                return Ok(inner.snapshot.clone());
            }
            let Some(candidate) = inner.candidate.take() else {
                return Err("No verified update is ready to install.".into());
            };
            let Some(bytes) = inner.bytes.take() else {
                inner.candidate = Some(candidate);
                return Err("No verified update is ready to install.".into());
            };
            inner.installing = true;
            inner.snapshot.state = UpdateState::Installing;
            inner.snapshot.can_install = false;
            inner.snapshot.error = None;
            (candidate, bytes, inner.snapshot.clone())
        };
        self.publish(installing);

        match self.backend.install(candidate, bytes) {
            Ok(()) => {
                let snapshot = {
                    let mut inner = self.inner.lock().expect("update manager poisoned");
                    inner.installing = false;
                    inner.snapshot.state = UpdateState::Idle;
                    inner.snapshot.downloaded_bytes = None;
                    inner.snapshot.total_bytes = None;
                    inner.snapshot.progress_percent = None;
                    inner.snapshot.clone()
                };
                self.publish(snapshot.clone());
                Ok(snapshot)
            }
            Err(err) => {
                let snapshot = {
                    let mut inner = self.inner.lock().expect("update manager poisoned");
                    inner.installing = false;
                    inner.candidate = None;
                    inner.bytes = None;
                    inner.snapshot.state = UpdateState::Failed;
                    inner.snapshot.can_install = false;
                    inner.snapshot.downloaded_bytes = None;
                    inner.snapshot.total_bytes = None;
                    inner.snapshot.progress_percent = None;
                    inner.snapshot.error = Some(UpdateErrorView {
                        phase: UpdatePhase::Install,
                        message: err.message.to_string(),
                        retryable: true,
                    });
                    inner.snapshot.clone()
                };
                self.publish(snapshot);
                Err(err.message.to_string())
            }
        }
    }
}

fn accepts_upgrade(current: &str, candidate: &str) -> Result<bool, semver::Error> {
    let current = Version::parse(current)?;
    let candidate = Version::parse(candidate)?;
    Ok(candidate.pre.is_empty() && candidate > current)
}

fn apply_check_error<C>(inner: &mut UpdateInner<C>, policy: CheckPolicy, error: BackendError) {
    inner.candidate = None;
    inner.bytes = None;
    inner.snapshot.can_install = false;
    if policy == CheckPolicy::Silent {
        eprintln!("[updater] automatic check skipped ({:?})", error.kind);
        inner.snapshot.state = UpdateState::Idle;
        inner.snapshot.error = None;
        return;
    }
    inner.snapshot.state = UpdateState::Failed;
    inner.snapshot.release_url =
        (error.kind == BackendErrorKind::Unsupported).then(|| RELEASE_PAGE.to_string());
    inner.snapshot.error = Some(UpdateErrorView {
        phase: UpdatePhase::Check,
        message: error.message.to_string(),
        retryable: error.kind != BackendErrorKind::Unsupported,
    });
}

pub(crate) type DesktopUpdateManager = UpdateManager<TauriUpdateBackend>;

pub(crate) fn new_desktop_manager(
    app: AppHandle,
    auto_download_updates: bool,
    publish: Publisher,
) -> DesktopUpdateManager {
    let current_version = app.package_info().version.to_string();
    UpdateManager::new(
        TauriUpdateBackend::new(app),
        current_version,
        auto_download_updates,
        publish,
    )
}

#[tauri::command]
pub fn update_status(manager: tauri::State<'_, DesktopUpdateManager>) -> UpdateSnapshot {
    manager.snapshot()
}

#[tauri::command]
pub async fn check_for_updates(
    manager: tauri::State<'_, DesktopUpdateManager>,
) -> Result<UpdateSnapshot, String> {
    Ok(manager
        .inner()
        .clone()
        .check(CheckPolicy::Interactive)
        .await)
}

#[tauri::command]
pub async fn download_update(
    manager: tauri::State<'_, DesktopUpdateManager>,
) -> Result<UpdateSnapshot, String> {
    let owned = manager.inner().clone();
    if owned.snapshot().state == UpdateState::Failed {
        let checked = owned.check(CheckPolicy::Interactive).await;
        if checked.state != UpdateState::Available {
            return Ok(checked);
        }
    }
    Ok(owned.download().await)
}

#[tauri::command]
pub fn install_update(
    manager: tauri::State<'_, DesktopUpdateManager>,
) -> Result<UpdateSnapshot, String> {
    manager.install()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Clone)]
    struct FakeCandidate(CandidateMetadata);

    #[derive(Clone)]
    struct FakeBackend {
        result: Arc<Mutex<Result<Option<FakeCandidate>, BackendError>>>,
        check_delay: Duration,
        download_delay: Duration,
        download_ok: Arc<AtomicBool>,
        install_ok: Arc<AtomicBool>,
        check_calls: Arc<AtomicUsize>,
        download_calls: Arc<AtomicUsize>,
        install_calls: Arc<AtomicUsize>,
    }

    impl FakeBackend {
        fn available(version: &str) -> Self {
            Self {
                result: Arc::new(Mutex::new(Ok(Some(FakeCandidate(CandidateMetadata {
                    version: version.into(),
                    notes: Some("Release notes".into()),
                    release_url: RELEASE_PAGE.into(),
                    can_install: true,
                }))))),
                check_delay: Duration::ZERO,
                download_delay: Duration::ZERO,
                download_ok: Arc::new(AtomicBool::new(true)),
                install_ok: Arc::new(AtomicBool::new(true)),
                check_calls: Arc::new(AtomicUsize::new(0)),
                download_calls: Arc::new(AtomicUsize::new(0)),
                install_calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn no_update() -> Self {
            let backend = Self::available("1.1.0");
            *backend.result.lock().unwrap() = Ok(None);
            backend
        }

        fn failing(error: BackendError) -> Self {
            let backend = Self::available("1.1.0");
            *backend.result.lock().unwrap() = Err(error);
            backend
        }
    }

    impl UpdateBackend for FakeBackend {
        type Candidate = FakeCandidate;

        fn check(&self) -> BackendFuture<Option<Self::Candidate>> {
            self.check_calls.fetch_add(1, Ordering::SeqCst);
            let delay = self.check_delay;
            let result = self.result.lock().unwrap().clone();
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                result
            })
        }

        fn metadata(&self, candidate: &Self::Candidate) -> CandidateMetadata {
            candidate.0.clone()
        }

        fn download(
            &self,
            candidate: Self::Candidate,
            progress: ProgressCallback,
        ) -> BackendFuture<(Self::Candidate, Vec<u8>)> {
            self.download_calls.fetch_add(1, Ordering::SeqCst);
            let delay = self.download_delay;
            let ok = self.download_ok.load(Ordering::SeqCst);
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                progress(1, Some(100));
                for current in 2..100 {
                    progress(current, Some(100));
                }
                progress(100, Some(100));
                if ok {
                    Ok((candidate, vec![7; 100]))
                } else {
                    Err(BackendError::download())
                }
            })
        }

        fn install(
            &self,
            _candidate: Self::Candidate,
            _bytes: Vec<u8>,
        ) -> Result<(), BackendError> {
            self.install_calls.fetch_add(1, Ordering::SeqCst);
            if self.install_ok.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(BackendError::install())
            }
        }
    }

    fn test_manager(
        backend: FakeBackend,
        auto_download: bool,
    ) -> (UpdateManager<FakeBackend>, Arc<Mutex<Vec<UpdateSnapshot>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let manager = UpdateManager::new(
            backend,
            "1.0.0".into(),
            auto_download,
            Arc::new(move |snapshot| captured.lock().unwrap().push(snapshot)),
        );
        (manager, events)
    }

    #[test]
    fn semver_acceptance_is_stable_and_upgrade_only() {
        assert!(accepts_upgrade("1.0.0", "1.0.1").unwrap());
        assert!(!accepts_upgrade("1.0.0", "1.0.0").unwrap());
        assert!(!accepts_upgrade("1.0.0", "0.9.9").unwrap());
        assert!(!accepts_upgrade("1.0.0", "1.1.0-beta.1").unwrap());
        assert!(accepts_upgrade("1.0.0", "not-semver").is_err());
    }

    #[tokio::test]
    async fn newer_release_becomes_available_but_equal_older_prerelease_and_invalid_do_not() {
        let (manager, _) = test_manager(FakeBackend::available("1.1.0"), false);
        assert_eq!(
            manager.check(CheckPolicy::Interactive).await.state,
            UpdateState::Available
        );

        for version in ["1.0.0", "0.9.0", "1.1.0-beta.1", "invalid"] {
            let (manager, _) = test_manager(FakeBackend::available(version), false);
            assert_eq!(
                manager.check(CheckPolicy::Interactive).await.state,
                UpdateState::UpToDate
            );
        }
    }

    #[tokio::test]
    async fn no_candidate_reports_up_to_date() {
        let (manager, _) = test_manager(FakeBackend::no_update(), false);
        let snapshot = manager.check(CheckPolicy::Interactive).await;
        assert_eq!(snapshot.state, UpdateState::UpToDate);
        assert!(snapshot.error.is_none());
    }

    #[tokio::test]
    async fn silent_failure_and_timeout_return_to_idle_without_user_error() {
        let (manager, _) = test_manager(FakeBackend::failing(BackendError::network()), false);
        let snapshot = manager.check(CheckPolicy::Silent).await;
        assert_eq!(snapshot.state, UpdateState::Idle);
        assert!(snapshot.error.is_none());

        let mut backend = FakeBackend::available("1.1.0");
        backend.check_delay = Duration::from_millis(50);
        let (mut manager, _) = test_manager(backend, false);
        manager.check_timeout = Duration::from_millis(5);
        let snapshot = manager.check(CheckPolicy::Silent).await;
        assert_eq!(snapshot.state, UpdateState::Idle);
        assert!(snapshot.error.is_none());
    }

    #[tokio::test]
    async fn interactive_failure_is_visible_and_retryable() {
        let (manager, _) = test_manager(FakeBackend::failing(BackendError::network()), false);
        let snapshot = manager.check(CheckPolicy::Interactive).await;
        assert_eq!(snapshot.state, UpdateState::Failed);
        assert_eq!(snapshot.error.unwrap().phase, UpdatePhase::Check);
    }

    #[tokio::test]
    async fn interactive_unsupported_build_offers_only_the_release_page() {
        let backend = FakeBackend::failing(BackendError::unsupported());
        let downloads = backend.download_calls.clone();
        let (manager, _) = test_manager(backend, true);
        let snapshot = manager.check(CheckPolicy::Interactive).await;
        assert_eq!(snapshot.state, UpdateState::Failed);
        assert_eq!(snapshot.release_url.as_deref(), Some(RELEASE_PAGE));
        assert!(!snapshot.error.unwrap().retryable);
        assert_eq!(downloads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn production_target_errors_map_to_unsupported_without_reclassifying_network_errors() {
        for error in [
            UpdaterError::TargetNotFound("windows-x86_64".into()),
            UpdaterError::TargetsNotFound(vec!["darwin-universal".into()]),
        ] {
            assert_eq!(
                classify_updater_check_error(error).kind,
                BackendErrorKind::Unsupported
            );
        }
        assert_eq!(
            classify_updater_check_error(UpdaterError::Network("offline".into())).kind,
            BackendErrorKind::Network
        );
    }

    #[tokio::test]
    async fn overlapping_checks_are_single_flight() {
        let mut backend = FakeBackend::available("1.1.0");
        backend.check_delay = Duration::from_millis(40);
        let calls = backend.check_calls.clone();
        let (manager, _) = test_manager(backend, false);
        let first = manager.clone();
        let task = tokio::spawn(async move { first.check(CheckPolicy::Silent).await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(
            manager.check(CheckPolicy::Interactive).await.state,
            UpdateState::Checking
        );
        assert_eq!(task.await.unwrap().state, UpdateState::Available);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unsupported_target_never_downloads_and_keeps_release_fallback() {
        let backend = FakeBackend::available("1.1.0");
        backend
            .result
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .as_mut()
            .unwrap()
            .0
            .can_install = false;
        let calls = backend.download_calls.clone();
        let (manager, _) = test_manager(backend, false);
        let snapshot = manager.check(CheckPolicy::Interactive).await;
        assert_eq!(snapshot.state, UpdateState::Available);
        assert!(!snapshot.can_install);
        assert_eq!(manager.download().await.state, UpdateState::Available);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn automatic_download_is_opt_in_and_never_installs() {
        let backend = FakeBackend::available("1.1.0");
        let downloads = backend.download_calls.clone();
        let installs = backend.install_calls.clone();
        let (manager, _) = test_manager(backend, false);
        assert_eq!(
            manager.check(CheckPolicy::Silent).await.state,
            UpdateState::Available
        );
        assert_eq!(downloads.load(Ordering::SeqCst), 0);

        assert!(manager.preference_changed(true));
        assert_eq!(manager.download().await.state, UpdateState::Ready);
        assert_eq!(downloads.load(Ordering::SeqCst), 1);
        assert_eq!(installs.load(Ordering::SeqCst), 0);
        assert!(!manager.preference_changed(true));
    }

    #[tokio::test]
    async fn disabling_preference_before_automatic_start_prevents_download() {
        let backend = FakeBackend::available("1.1.0");
        let downloads = backend.download_calls.clone();
        let (manager, _) = test_manager(backend, false);
        assert_eq!(
            manager.check(CheckPolicy::Interactive).await.state,
            UpdateState::Available
        );

        assert!(manager.preference_changed(true));
        assert!(!manager.preference_changed(false));
        assert_eq!(
            manager.download_automatically().await.state,
            UpdateState::Available
        );
        assert_eq!(downloads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn enabled_discovery_downloads_once_and_progress_finishes_exactly() {
        let backend = FakeBackend::available("1.1.0");
        let downloads = backend.download_calls.clone();
        let (manager, events) = test_manager(backend, true);
        let snapshot = manager.check(CheckPolicy::Silent).await;
        assert_eq!(snapshot.state, UpdateState::Ready);
        assert_eq!(snapshot.downloaded_bytes, Some(100));
        assert_eq!(snapshot.progress_percent, Some(100.0));
        assert_eq!(downloads.load(Ordering::SeqCst), 1);
        let progress_events = events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.state == UpdateState::Downloading)
            .count();
        assert!(progress_events <= 3, "progress must be throttled");
    }

    #[tokio::test]
    async fn duplicate_download_and_disable_during_download_do_not_cancel_or_restart() {
        let mut backend = FakeBackend::available("1.1.0");
        backend.download_delay = Duration::from_millis(40);
        let calls = backend.download_calls.clone();
        let (manager, _) = test_manager(backend, false);
        manager.check(CheckPolicy::Interactive).await;
        let first = manager.clone();
        let task = tokio::spawn(async move { first.download().await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(manager.download().await.state, UpdateState::Downloading);
        assert!(!manager.preference_changed(false));
        let ready = task.await.unwrap();
        assert_eq!(ready.state, UpdateState::Ready);
        assert!(!ready.auto_download_updates);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn verification_failure_discards_bytes_and_has_download_retry_boundary() {
        let backend = FakeBackend::available("1.1.0");
        backend.download_ok.store(false, Ordering::SeqCst);
        let installs = backend.install_calls.clone();
        let (manager, _) = test_manager(backend, false);
        manager.check(CheckPolicy::Interactive).await;
        let failed = manager.download().await;
        assert_eq!(failed.state, UpdateState::Failed);
        assert_eq!(failed.error.unwrap().phase, UpdatePhase::Download);
        assert!(!failed.can_install);
        assert!(manager.install().is_err());
        assert_eq!(installs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn installation_is_explicit_and_failure_clears_staged_artifact() {
        let backend = FakeBackend::available("1.1.0");
        backend.install_ok.store(false, Ordering::SeqCst);
        let installs = backend.install_calls.clone();
        let (manager, _) = test_manager(backend, true);
        assert_eq!(
            manager.check(CheckPolicy::Silent).await.state,
            UpdateState::Ready
        );
        assert_eq!(installs.load(Ordering::SeqCst), 0);
        assert!(manager.install().is_err());
        let failed = manager.snapshot();
        assert_eq!(failed.state, UpdateState::Failed);
        assert_eq!(failed.error.unwrap().phase, UpdatePhase::Install);
        assert!(manager.install().is_err());
        assert_eq!(installs.load(Ordering::SeqCst), 1);
    }
}
