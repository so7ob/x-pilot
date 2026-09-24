# Changelog
## [1.3.0] - Feature
### Added
- استكمال واجهة الاستعادة بإجراء **البدء من جديد**: يعيد العناصر الفاشلة والمتقطعة إلى الانتظار بحالة نظيفة (تصفير المحاولات ومسح بيانات النشر) وينهي الجلسة الحالية بعد تأكيد صريح يعرض عدد العناصر المتأثرة.
- إجراء **إلغاء الجلسة** في بطاقة الاستعادة بجانب الاستئناف، لإيقاف الجلسة دون تغيير حالات العناصر.
- شارة عداد على زر البدء من جديد تظهر عدد العناصر القابلة لإعادة التعيين، مع تلميح أمان يوضح نطاق الإجراء.
- عقود معمارية جديدة تضمن أن البدء من جديد مفوّض لطبقة domain ولا يستدعي مسار النشر أبدًا ولا يبدأ جلسة جديدة تلقائيًا.

### Safety
- العناصر المنشورة وغير المؤكدة والمخطاة لا تُلمس أبدًا أثناء البدء من جديد.
- العنصر أثناء النشر `PUBLISHING` يتحول إلى `PUBLISHED_UNVERIFIED` ولا يُعاد إلى الانتظار مطلقًا.
- المواضع وبصمات المحتوى وبيانات التكرار محفوظة بعد إعادة التعيين.

## [1.2.0] - Feature
### Added
- تصدير أي بنك تغريدات كملف JSON محلي مغلف بصيغة `x-pilot-tweet-bank` من زر تصدير في بطاقة كل بنك.
- تصدير جميع البنوك غير المؤرشفة في مساحة العمل دفعة واحدة بصيغة `x-pilot-tweet-banks` من زر تصدير كل البنوك.
- استيراد بنوك التغريدات من ملف JSON مع قبول المغلف المفرد والمغلف المتعدد والمصفوفة الخام، وربط البنوك المستوردة بمساحة العمل الحالية دون المساس بقائمة الانتظار أو الجلسات أو السجل.
- توليد معرفات جديدة للبنوك المستوردة والحفاظ على عزل مساحات العمل عبر عدم تضمين `workspaceId` أو `id` في ملفات التصدير مطلقًا.
- تحقق كامل من ملفات الاستيراد: صيغة غير مدعومة، إصدار غير مدعوم، ملف فارغ، تجاوز حد 100 بنك لكل ملف أو 5000 رابط لقطة لكل بنك، روابط غير صالحة، ولقطات تالفة مع رسائل مفهومة بالعربية والإنجليزية.
- عقود معمارية تضمن تفويض التحقق لطبقة domain وسلامة عزل مساحات العمل وعدم كتابة `importBanks` لأي بيانات غير البنوك.
- 12 اختبارًا سلوكيًا جديدًا يغطي بناء التصدير وقبول الاستيراد ورفض الملفات غير الصالحة ودورة تصدير/استيراد كاملة.

## [1.1.1] - Patch
### Fixed
- تطبيق اختيار Badge Mode فورًا بعد حفظه بدل انتظار إعادة تشغيل المتصفح.
- مزامنة نص الشارة مع إعداد `COUNT` أو `STATUS` أو `NONE` مباشرة عبر Service Worker.
- إضافة عقد معماري يمنع عودة تأخر تحديث الشارة.

## [1.1.0] - Feature
### Added
- دمج تبويبي الجلسات والسجل في تبويب نشاط واحد يعرض ملخص الجلسة، وقت البدء والانتهاء، المدة، الحالة، النجاح، الفشل، التخطي، وعدد المحاولات.
- إدراج سجل تفصيلي لكل جلسة يوضح كل تغريدة ووقت التنفيذ وعدد المحاولات والنتيجة ورابط المصدر.
- التقاط رابط المنشور الفعلي من صفحة X بعد النشر وعرضه منفصلًا عن رابط المصدر في سجل النشاط.
- الحفاظ على التوافق مع السجلات القديمة التي لا تحتوي على رابط منشور فعلي.
- إضافة عقود معمارية وتنسيق متجاوب لعرض ملخصات الجلسات وسجل المحاولات المتداخل.

## [1.0.2] - Patch
### Fixed
- طلب صلاحية النطاق الاختيارية قبل تنفيذ تحديث ومقارنة بنك التغريدات لأول مرة.
- تحويل أخطاء Chrome من نوع `Cannot access contents of url` إلى رسالة صلاحية مفهومة للمستخدم بدل عرض الخطأ الخام.
- إضافة اختبار معماري يضمن تنفيذ طلب الصلاحية قبل قراءة صفحة البنك.

## [1.0.1] - Patch
### Fixed
- إزالة خيار `Active Workspace` وsentinel `@active` من واجهة Workspace Filter.
- جعل `workspaceId` يحمل دائمًا معرف Workspace الفعلي بعد التهيئة، أو `*` عند اختيار جميع المساحات.
- مزامنة Queue وTweet Banks وSessions وHistory فور تغيير Workspace الرئيسية.
- جعل Clear Filters يعيد الفلتر إلى Workspace النشطة بدل All Workspaces.
- إضافة اختبارات قبول C1–C11 لسلوك Workspace Filters.

## [1.0.0] - Stable
### Added
- توحيد بيانات العرض في واجهة Side Panel حول حالة Workspace المشتركة مع مصالحة فورية لنتائج العمليات.
- إضافة نطاقات Workspace صريحة: مساحة العمل النشطة، كل المساحات، ومساحة محددة.
- حماية نتائج التحديث غير المتزامنة من الكتابة فوق بيانات أحدث.

### Fixed
- استمرار حصرية START عبر تجديد Lease أثناء عمليات Preflight وبدء الأتمتة الطويلة.
- معالجة فشل Alarm بعد انتقال الجلسة إلى `RUNNING` بإعادة محاولة قابلة للاسترداد أو فشل صريح.
- منع إدخال المساحات المؤرشفة ضمن النطاق التشغيلي لكل المساحات.
- إضافة اختبارات سلوكية فعلية لنطاقات Workspace ومصالحة Cache وتجديد START.

## [0.25.8] - Patch
### Fixed
- منع إعادة النشر التلقائي بعد انقطاع Service Worker أثناء `PUBLISHING` عبر حفظ Publish Intent وتحويل النتيجة غير المؤكدة إلى `PUBLISHED_UNVERIFIED`.
- إضافة قفل START مستمر ومميز بـToken لمنع انتقالَي START المتزامنين.
- معالجة أخطاء Alarm بسياسة Retry محدودة مع تحديث حالة الجلسة وإشعار المستخدم بدل ابتلاع الخطأ.
- تحويل Restore إلى عملية Stage → Verify → Commit مع Rollback والحفاظ على الحالة السابقة عند فشل الكتابة.
- استعادة الجلسات المجدولة المستقبلية بعد Restart وتحويل الجلسات الفائتة إلى `PAUSED` بدل بقائها `SCHEDULED` بلا Trigger.
- إضافة سبعة اختبارات تكامل P0 للتحقق من الانتقالات واستدعاءات التخزين وقواعد الاستعادة الآمنة.

## [0.25.7] - Patch
### Fixed
- توحيد حواف بطاقات ملف إعدادات Workspace والنسخ الاحتياطي مع بقية بطاقات الواجهة.
- ترتيب أزرار حفظ إعدادات Workspace وتصدير واستعادة النسخة الاحتياطية في شبكة متناسقة.
- دعم ترتيب متجاوب للأزرار على الشاشات الضيقة مع الحفاظ على RTL/LTR.

## [0.25.6] - Patch
### Fixed
- ترجمة نطاق الصفحات مثل `1–10 من 177` وصيغة `صفحة 1 من 18` حسب اللغة المختارة.
- توحيد بطاقة Diagnostics وعرض أسماء الفحوصات والحالات والتفاصيل بالعربية أو الإنجليزية.
- تحويل `PUBLISH_CONTROLS_NOT_READY` وتفاصيل الصلاحيات ومعلومات Alarm إلى رسائل مفهومة للمستخدم.

## [0.25.5] - Patch
### Fixed
- ترجمة عدادات بنوك التغريدات وقائمة الانتظار بدل عرض الصيغة الثابتة مثل `1 من 1 بنك` و`177 من 177 عنصر`.
- ترجمة تسميات `عرض في الصفحة` و`تحديد عناصر الصفحة` في Queue.
- إضافة مفاتيح واختبارات تغطية لهذه العناصر لضمان دعم RTL/LTR.

## [0.25.4] - Patch
### Fixed
- إصلاح ظهور `ui.remaining` و`banks.hint` و`backup.hint` كمفاتيح خام في الواجهة العربية.
- ترجمة عناوين وعدادات وحالات تبويبات الجلسات والسجل والتحليلات ومساحات العمل والإعدادات.
- إضافة اختبار يمنع عودة مفاتيح الترجمة الخام في هذه المناطق.

## [0.25.3] - Patch
### Fixed
- استكمال تغطية الترجمة في الواجهة الرئيسية وتبويبات التشخيص والاختبارات وبنوك التغريدات وقائمة Queue والإعدادات.
- جعل نتائج Preflight وDiagnostics محايدة لغويًا مع عرضها وفق اللغة المختارة، وترجمة إشعارات Background وبيانات Manifest.
- إضافة فحص تكافؤ مفاتيح العربية والإنجليزية مع الحفاظ على RTL/LTR وسلامة Dry Run وعدم النشر أثناء Diagnostics.

## [0.25.2] - Patch
### Fixed
- استكمال ترجمة العناوين والأزرار المتبقية في واجهة العربية، بما في ذلك Dry Run وPreflight وBulk Queue والترويسة ومراجعة Refresh & Diff.
- ترجمة حالات العناصر وبيانات المحاولات وأزرار الإجراءات مع الحفاظ على منطق التشغيل دون تغيير.

## [0.25.1] - Unreleased

### Changed

- استكمال ربط مفاتيح الترجمة في إعدادات Workspace وتبويبي Queue وبنوك التغريدات والجلسات والسجل ومساحات العمل.
- إضافة مفردات مشتركة للعربية والإنجليزية للأزرار والحالات ورسائل التشغيل.
- الحفاظ على RTL/LTR ومنطق النشر والجدولة دون تغيير.

## [0.25.0] - Unreleased

### Added

- طبقة i18n مركزية تدعم العربية والإنجليزية مع وضع تلقائي يعتمد على لغة المتصفح.
- اختيار اللغة من Settings مع حفظ التفضيل محليًا داخل `chrome.storage.local`.
- مزامنة `lang` و`dir` تلقائيًا لدعم RTL العربية وLTR الإنجليزية.
- بدء نقل النصوص المشتركة في الترويسة والتنقل والتشغيل واختبارات البدء والتحليلات والتشخيص إلى مفاتيح ترجمة قابلة للتوسع.

## [0.24.1] - Patch

### Fixed

- عرض `X_DAILY_POST_LIMIT_REACHED` للمستخدم بالعربية: **لقد وصلت إلى الحد الأقصى لعدد المنشورات اليومية**.
- إبقاء الرمز الداخلي متاحًا للتشخيص والمنطق البرمجي دون عرضه في بطاقات الواجهة أو السجل.

## [0.24.0] - Unreleased

### Added

- Pagination داخل تبويب Queue مع خيارات عرض 10 أو 50 أو 100 عنصر أو الكل.
- أزرار السابق والتالي مع عرض رقم الصفحة ونطاق العناصر الحالي.
- إعادة الصفحة إلى الأولى عند تغيير البحث أو الفلاتر.
- تحديد عناصر الصفحة الحالية مع الحفاظ على التحديد عند الانتقال بين الصفحات.

## [0.23.2] - Patch

### Fixed

- اكتشاف رسالة X الخاصة بتجاوز الحد الأقصى للمنشورات اليومية بالعربية والإنجليزية.
- إيقاف الجلسة مؤقتًا عند ظهور الحد اليومي بدل متابعة النشر.
- إبقاء العنصر الحالي `PENDING` وعدم الانتقال إلى العنصر التالي.
- إلغاء Alarm التالي وعدم احتساب الحالة كمحاولة نشر فاشلة.

## [0.23.1] - Patch

### Changed

- رسائل النجاح والمعلومات مثل حفظ إعدادات Workspace تظهر كـToast مؤقت وتختفي تلقائيًا بعد 3.5 ثوانٍ.
- رسائل الخطأ تبقى ظاهرة حتى يقرأها المستخدم، مع إمكانية إغلاقها يدويًا.
- إزالة الفوتر العام غير الضروري من واجهة Side Panel.

## [0.23.0] - Unreleased

### Changed

- استبدال حقل `Publishing Windows JSON` بمحرر مرئي سهل الاستخدام.
- إضافة اختيار أيام الأسبوع وأوقات البداية والنهاية لكل نافذة.
- دعم إضافة وحذف وتفعيل وتعطيل عدة نوافذ نشر.
- إبقاء JSON داخليًا للتخزين والنسخ الاحتياطي دون مطالبة المستخدم بكتابته.

## [0.22.0] - Unreleased

### Changed

- فُصلت تبويبات التشغيل واختبارات البدء والتحليلات والتشخيص إلى وحدات UI مستقلة دون Lazy Loading أو تغيير Business Logic.
- وُحّدت ترويسة `app-header` ومسافات العرض في جميع التبويبات.
- أصبح `workspace-switcher premium-switcher` يعرض `WORKSPACE ACTIVE` واسم المساحة بجوار زر إدارة مساحات العمل.
- أزيل عداد العناصر والمنشورات والرمز `◈` من مربع Workspace المختصر.

## [0.21.1] - Rollback

### Changed

- أُعيد تخطيط التبويبات إلى الشكل السابق قبل v0.21.0 بناءً على طلب المستخدم.
- أُعيدت المسافات والتنسيق السابقان للتبويبات، مع بقاء نقل المؤقت إلى لوحة التشغيل كما هو في v0.20.1.
- لم يتم التراجع عن إصلاحات التشغيل أو الجدولة أو الأتمتة السابقة.

## [0.20.1] - Patch

### Changed

- نُقل مؤقت الانتظار وموعد الجلسة المجدولة إلى بطاقة **لوحة التشغيل**.
- أصبحت حالة العدّ التنازلي واضحة بجوار مؤشرات النشر بدل وجودها أسفل أدوات التحكم.
- أزيل التكرار من بطاقة أدوات التشغيل مع الحفاظ على منطق الجدولة والـAlarm كما هو.

## [0.20.0] - Unreleased

### Changed

- ضُيّقت بطاقة مساحة العمل النشطة لتوفير مساحة أكبر للوحة التشغيل.
- أصبحت تبويبات التنقل مخفية افتراضيًا في شاشة التشغيل وتظهر عند تمرير المؤشر أو استخدام التركيز عبر لوحة المفاتيح.
- تم ضغط لوحة التشغيل وبطاقة التغريدة الحالية والمؤقت لتظهر بوضوح داخل Side Panel.
- أُضيفت قواعد ارتفاع الشاشة لتقليل الحاجة إلى شريط التمرير العمودي.
- لم يتغير أي Business Logic أو Runtime Message أو مسار أتمتة.

## [0.19.6] - Patch

### Fixed

- `Start` now creates a complete Automation Session when the Workspace has no persisted session.
- The first runnable Queue item is assigned as the current item, restoring the Current Tweet card and operation controls.
- Automation-tab creation now runs inside the guarded publish flow; failures are converted to the normal retry/continue state instead of leaving an item stuck.
- The session and Queue state are broadcast after startup so the UI controls remain synchronized.

## [0.19.5] - Patch

### Fixed

- Preflight now opens the first runnable Queue item URL instead of only opening X Home.
- The check follows the Dry Run sequence: navigate, wait for load, activate the tab, inject Content Script if needed, and run `X_INSPECT`.
- The temporary inspection tab is restored and closed in `finally`; no Post action or Queue mutation occurs.
- Composer and Post Button readiness is now validated on the actual item Composer.

## [0.19.4] - Patch

### Fixed

- Individual Queue actions now persist through the same runtime path as Bulk Actions.
- Delete, Retry, Skip, Clear Completed, and Reorder broadcast `STATE_UPDATED` immediately.
- Deleted items disappear immediately and are removed from the selected-items state.

## [0.19.3] - Patch

### Fixed

- Fixed invalid SVG `<path>` errors caused by splitting a valid path definition into invalid fragments.
- Restored reliable rendering and interaction for navigation, Workspace, Queue, Bank, operation, and action buttons.
- Added a regression contract preventing SVG path splitting from returning.

## [0.19.2] - Patch

### Fixed

- Preflight now automatically reuses an X tab or opens a temporary `https://x.com/home` tab and runs `X_INSPECT` before reporting readiness.
- Temporary Preflight tabs are removed in `finally` and no Post action is executed.
- Preflight results now render as compact adjacent status cards, with a single column fallback on narrow panels.
- Removed the misleading instruction asking the user to open X manually.

## [0.19.1] - Patch

### Fixed

- Dry Run no longer fails immediately when the Workspace has Queue items but no active Automation Session.
- Dry Run now creates a temporary X tab, waits for navigation, injects the Content Script, inspects Composer/content/Post readiness, and removes the temporary tab in `finally`.
- Dry Run surfaces the actual startup error instead of only showing `FAILED`.
- The no-Post and no-attempt-mutation boundaries remain unchanged.

## [0.19.0] - Unreleased

### Added

- Premium RTL Side Panel shell with grouped Control, Content, Activity, Insights, and Manage navigation.
- Token-based visual system for graphite, electric blue, cyan, semantic status colors, spacing, radii, shadows, typography, focus, and motion.
- Local SVG icon system and reusable UI primitives for status badges, metrics, progress, cards, and empty states.
- Redesigned Operation Dashboard with Workspace context, publish progress, remaining/failed/skipped metrics, and clearer action hierarchy.
- Responsive layouts for narrow Side Panel widths and reduced-motion support.

### Preserved

- Existing RuntimeMessage contracts, automation behavior, Dry Run no-post boundary, Diagnostics read-only boundary, scheduling, Queue, Banks, Sessions, History, Analytics, and Settings behavior.

## [0.18.2] - Patch

### Added

- Data Integrity validation for corrupted records, missing fields, duplicate Queue IDs, orphan attempts, and missing Bank references.
- Safe stale Alarm classification and terminal Queue-item no-republish guards.
- Restart coverage for publishing, waiting, scheduled, and old-session states.

### Changed

- Bank deletion now preserves referenced Queue and History through archival instead of breaking references.
- Workspace deletion now creates an archive tombstone and preserves Queue, Attempts, and Session Records.
- Corrupted or incomplete Workspace records are normalized at the storage boundary with safe defaults.

## [0.18.1] - Patch

### Changed

- Added an explicit ordered storage migration registry for legacy, schema 2, schema 3, and schema 4 transitions.
- Added non-persistent timing for selected `chrome.storage.local` reads and writes; slow operations are reported through `console.debug` without recording content or URLs.
- Preserved existing storage keys during the first migration and added regression coverage for idempotency and data retention.

## [0.18.0] - Unreleased

### Added

- Data Architecture v4 with separate App Metadata, Global Settings, Workspace Settings, Automation Runtime, Session Records, Publish Attempts, and canonical Queue/Bank stores.
- Idempotent migration from schema v3 without deleting legacy keys during the initial migration.
- Backup format v2 that includes durable records and excludes Chrome runtime resources.

## [0.17.0] - Unreleased

### Added

- Read-only Diagnostics Center for Extension version, Storage schema, Workspaces, Session, Alarm, Automation Tab, X Login, Adapter, Composer, Post Button, and Permissions.
- `Run Diagnostics` uses `X_INSPECT` only and never publishes, changes Queue, or starts automation.

## [0.16.0] - Unreleased

### Added

- Analytics Dashboard with Workspace KPIs and global X-Pilot metrics.
- Derived Total sessions, Total posts, Published, Failed, Skipped, Success Rate, Average attempts, Average session duration, Most active bank, Last activity, and Sessions over time.
- Analytics are calculated from existing Sessions, History, Queue, and Workspace records without duplicated stored statistics.

## [0.15.0] - Unreleased

### Added

- Multi-select Queue items with Delete, Skip, Retry, Reset to Pending, Move to top, Move to bottom, Assign Bank, and Export selected actions.
- Active publishing item protection with explicit warning/confirmation and a hard busy-state guard.

## [0.14.0] - Unreleased

### Added

- Advanced Search & Filters across Queue, Tweet Banks, Sessions, and Publish History.
- Status, Bank, Session, date-range, Workspace, and combined text filters.
- Dedicated Sessions tab and reusable RTL search toolbar with result counts and clear-filters action.
- Session and Workspace identifiers on publish history entries for accurate filtering.

## [0.13.3] - Patch

### Changed

- Moved PREFLIGHT CHECK and DRY RUN · NO POST into an independent RTL tab named اختبارات البدء.

## [0.13.2] - Patch

### Fixed

- Added the missing generic Failed item Chrome Notification while keeping per-success notifications disabled.

## [0.13.1] - Patch

### Fixed

- Dry Run results now show only the Queue item number, status, and first ten words; raw target URLs are no longer rendered.
- Scheduled Sessions now create a runnable session when Queue had no prior session and report a clear failure when no item is runnable at Alarm time.
- Scheduled Alarm handling now reschedules early alarms and persists observable failure state instead of silently returning.

## [0.13.0] - Unreleased

### Added

- Scheduled Sessions with persistent Chrome Alarm scheduling, rescheduling, cancellation, and startup recovery.
- Workspace Publishing Windows with weekday rules, multiple windows, overnight support, and explicit time zones.
- Workspace Automation Profiles inheriting from Global Defaults.
- Opt-in Chrome Notifications for important session events without per-success noise.
- Chrome Badge modes for remaining count, status, or no Badge.

## [0.12.0] - Unreleased

### Added

- Full local JSON Backup / Restore for all Workspaces, Tweet Banks, Queue items, Sessions, Session History, Publish Attempts, and settings.
- Pre-restore validation for format, schema, workspace ordering, bank references, Queue references, and active automation protection.
- Confirmation summary before replacing local data.
- Excludes transient Automation Tab and operation state from backups.

## [0.11.0] - Unreleased

### Added

- Dry Run / Test Mode for one item or the entire Queue.
- Sequential reuse of one automation tab for inspection.
- Structured results for login, content, Composer, Post button, invalid URL, challenge, and error states.
- Strict no-publish boundary: Dry Run never sends `X_PUBLISH`, changes Queue status, increments attempts, or creates publish history.

## [0.10.0] - Unreleased

### Added

- Preflight Check before Queue Start.
- Structured PASS/WARN/FAIL readiness report for Workspace, Queue, Banks, X Adapter, permissions, alarms, duplicates, retry configuration, and interval.
- Blocking Start guard for invalid Queue, X login/challenge, duplicate policy violations, missing permissions, and conflicting automation ownership.
- Dashboard readiness counts and actionable diagnostic details.

## [0.9.0] - Unreleased

### Added

- SHA-256 Content Fingerprint generation from supported tweet intent URLs.
- Normalized-content duplicate detection across Tweet Banks and Workspaces.
- Duplicate policies: Block, Warn, and Allow.
- Refresh & Diff warnings for queued duplicates and previously published content.
- Published duplicates are excluded from the default selection and blocked by the default policy.

## [0.8.0] - Unreleased

### Added

- Adds non-destructive Tweet Bank Refresh and Diff.
- Classifies refreshed links as New, Existing, Previously Published, Removed, or Invalid.
- Adds a review panel with selectable New items before Queue insertion.
- Prevents published items from being re-added automatically.
- Persists the latest Bank snapshot for future comparisons.

## [0.7.0] - Unreleased

### Added

- Adds independent Tweet Bank management inside each Workspace.
- Adds Bank creation, archive, restore, deletion protection, and metadata cards.
- Adds Bank-aware extraction and `sourceBankId` provenance on Queue items.
- Adds per-Bank Pending and Published counters while preserving Replace and Append modes.
- Normalizes legacy schema v3 Bank records with default favorite and archive fields.

## [0.6.0] - Unreleased

### Added

- Adds independent historical Automation Session records per Workspace.
- Adds a local Session History tab with status and result counters.
- Migrates Workspace storage from schema v2 to schema v3 while preserving existing Queue and attempts.
- Links runtime publish attempts and terminal session states to the historical session record.

## [0.5.1] - Unreleased

### Fixed

- Adds a visible Restore action for archived Workspaces.
- Adds explicit Replace and Append choices when extracting a Tweet Bank.
- Prevents replacing an active Queue or a Queue containing executed items without a guarded decision.
- Deduplicates appended links by target URL and preserves existing Queue items.

## [0.5.0] - Unreleased

### Added

- Adds real Workspace entities with independent Queue, Banks, Sessions, and History.
- Adds persisted active Workspace selection and a compact Workspace management tab.
- Adds schema version 2 migration from `xQueueState` and `xQueueSettings`.
- Adds a single global automation owner to prevent parallel Workspace sessions.
- Makes background state reads and writes use the persisted automation owner instead of the active UI Workspace.

## [0.4.1] - Unreleased

### Added

- Adds live connection and engine-activity indicators to the tab bar.
- Detects manually closed automation tabs and reports a disconnected state.
- Adds an accessible warning when the engine is active without a connected automation tab.

## [0.4.0] - Unreleased

### Added

- Splits the Side Panel into Operation, Tweet Bank, and Settings tabs.
- Adds a dashboard with current-tweet information, status, preview, attempts, and direct link.
- Keeps the Queue and bank extraction tools together in their dedicated tab.
- Preserves the branded Recovery card in the Operation tab.

## [0.3.7] - Unreleased

### Added

- Adds the official transparent X-Pilot logo to Chrome extension icons and the Side Panel.
- Adds branded Settings and Recovery surfaces.
- Documents the branding assets and includes the logo in the project README.

## [0.3.6] - Unreleased

### Fixed

- Applies automation-tab retention settings on Stop, completion, and final failure.
- Clears stale `automationTabId` state when the automation tab is manually removed.
- Prevents late automation errors from overwriting sessions already paused or stopped.
- Keeps the automation tab available during WAITING and PAUSED states when configured.

## [0.3.5] - Unreleased

### Fixed

- Prevents repeated Content Script injection per tab and removes injection state when tabs navigate or close.
- Adds a page-level guard so duplicate Content Script executions cannot register duplicate runtime listeners.
- Guarantees temporary bank-tab removal in `finally`, including extraction and scripting failures.

## [0.3.4] - Unreleased

### Fixed

- Opens the X target in the background first and activates the automation tab only after navigation completes.
- Gives X a short foreground-rendering window before readiness polling.
- Preserves restoration of the user's previous tab after the operation.

## [0.3.3] - Unreleased

### Fixed

- Activates the automation tab before waiting for X's dynamically rendered composer and publish controls.
- Handles tabs that are already complete without waiting indefinitely for a missed update event.
- Restores the user's previously active tab after publish, failure, or interruption.

## [0.3.2] - Unreleased

### Fixed

- Broadens X publish-control detection across button, role, data-testid, aria-label, title, and nested text variants.
- Normalizes Arabic whitespace, tatweel, and diacritics.
- Rejects hidden, disabled, reply, Add Post, and Post All controls before clicking.
- Adds regression coverage for localized publish labels.

## [0.3.1] - Unreleased

### Fixed

- Failed attempts now enter `WAITING` with a persisted Alarm for the next retry.
- The Queue persists the next item before waiting after a successful publish.
- The alarm handler prefers the persisted current item and no longer depends on recursive retry calls.
- Exhausted failures with Continue advance to the next item; exhausted failures with Pause remain paused.

## [0.3.0] - Unreleased

### Added

- Added persisted Queue recovery on browser startup and extension installation.
- Interrupted items are normalized back to `PENDING` without being marked published.
- Future waiting alarms are recreated idempotently from `nextRunAt`.
- Expired active sessions become `PAUSED` and require explicit Resume.
- Paused sessions remain paused across restart and published items are protected.

## [0.2.0] - Unreleased

### Added

- Added persisted Pause and Resume controls for Queue automation.
- Pause clears active alarms without advancing the current item.
- Resume continues the current eligible item or recreates a waiting alarm.
- Added state-machine and service-worker contract coverage for the lifecycle.

## [0.1.6] - 2026-09-20

### Fixed

- Detects Arabic X composer and publish controls, including `نص المنشور` and `نشر`.
- Avoids confusing `إضافة منشور` and `نشر الكل` thread controls with the single-post action.
- Schedules the next queue item after an exhausted failure and restarts its persisted countdown.

## [0.1.5] - 2026-09-20

### Added

- Queue rows now show a concise preview decoded from the tweet intent URL instead of the long URL.
- Queue actions remain visible with fixed-width controls on narrow Side Panels.
- Added a seconds countdown derived from the persisted `nextRunAt` timestamp.
- Added preview and Unicode truncation tests.

## [0.1.4] - 2026-09-20

### Fixed

- Polls for the X composer and enabled Post button for a bounded period before failing.
- Adds additional stable accessibility and test-id strategies for X publish controls.
- Advances to the next pending item after retries are exhausted when failure behavior is Continue.
- Marks the session Completed when the exhausted failure was the last remaining item.

## [0.1.3] - 2026-09-20

### Changed

- Renamed the Chrome extension display name and package identity to X-Pilot.
- Renamed the GitHub repository to `x-pilot`.

## [0.1.2] - 2026-09-20

### Release

- Formalized the extraction fix through the issue, feature branch, pull request, integration branches, release tag, and GitHub release workflow.

## [0.1.1] - 2026-09-20

### Fixed

- Bank extraction now reads X/Twitter intent URLs embedded in raw Google Sites markup, including HTML-encoded query parameters.
- The UI reports the actual number of extracted links instead of reporting success when the Queue is empty.
- Added parser tests for encoded links, duplicates, and unrelated page links.

## [0.1.0] - 2026-09-20

### Added

- Initial Manifest V3 scaffold with React, TypeScript, Vite, Side Panel, Service Worker, and Content Script.
- Local queue model for X/Twitter composer URLs.
- Local storage repository, initial state machine, alarm scheduling, retry state, and attempt history.
- Safe X provider inspection that refuses to click when the page, composer, content, or enabled post button cannot be verified.
- Dynamic request for the specific external bank host permission when the user presses extraction.

### Known limitations

- The first scaffold does not yet include the complete restart recovery dialog, Refresh Bank diff view, or import/export UI.
- X selectors are best-effort and require maintenance when the site UI changes.
