#include "station.h"
#include "experiment.h"
#include "experiment_policy.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <ctime>
#include <memory>
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace experiment {
enum class Phase : uint32_t { empty, pending, running, result };
struct Sample { uint32_t us; int16_t raw, mv; uint8_t step, valid; uint16_t reserved=0; };
struct State {
    uint32_t format=1, sequence=0;
    Phase phase=Phase::empty;
    int64_t expires=0, startedAt=0, nextUpload=0;
    char id[37]={}, firmware[32]={}, outcome[32]={};
    uint32_t interval=100, stepCount=0, sampleCount=0, cursor=0, attempts=0;
    Step steps[maxSteps]{};
    uint32_t stepStartUs[maxSteps]={}, stepEndUs[maxSteps]={};
    uint8_t stepOk[maxSteps]={};
    Sample samples[maxSamples]{};
};
static_assert(sizeof(Sample)==12 && sizeof(State)<=8192,"Review NVS reservation and RAM limits before changing the experiment layout");
enum class UploadReason : uint32_t {
    Interrupted, ExperimentNotCompleted, ClockUnavailable, Emergency, BatteryUnavailable,
    BatteryLow, WindowTooShort, WifiFailed, WifiStartFailed, WifiConnectFailed, WifiIpTimeout,
    Deadline, HttpFailed, StorageError, AttemptLimit, Completed, Count
};
static constexpr const char* uploadReasons[]={"interrupted","experiment_not_completed","clock_unavailable",
    "emergency","battery_unavailable","battery_low","window_too_short","wifi_failed","wifi_start_failed",
    "wifi_connect_failed","wifi_ip_timeout","deadline","http_failed","storage_error","attempt_limit","completed"};
static_assert(sizeof(uploadReasons)/sizeof(*uploadReasons)==unsigned(UploadReason::Count));
// Store diagnostics separately so the existing trace/ack blob survives firmware upgrades unchanged.
struct UploadReport {
    uint32_t format=1, sequence=0;
    char id[37]={};
    UploadReason reason=UploadReason::Interrupted;
    int32_t batteryMv=-1, wifiMs=-1, elapsedMs=-1;
    uint32_t httpAttempts=0, confirmedSamples=0;
};
static State state;
static UploadReport uploadReport;
static nvs_handle_t handle;
static bool ready=false;
static bool save() {
    return nvs_set_blob(handle,"state",&state,sizeof(state))==ESP_OK && nvs_commit(handle)==ESP_OK;
}
static void saveUploadReport() {
    if (nvs_set_blob(handle,"upload_diag",&uploadReport,sizeof(uploadReport))!=ESP_OK || nvs_commit(handle)!=ESP_OK)
        ESP_LOGW("experiment","Immediate upload diagnostic not persisted");
}
static const char* str(const cJSON* obj,const char* key) {
    auto v=cJSON_GetObjectItemCaseSensitive(obj,key);
    return cJSON_IsString(v) ? v->valuestring : "";
}
static int64_t number(const cJSON* obj,const char* key) {
    auto v=cJSON_GetObjectItemCaseSensitive(obj,key);
    if (!cJSON_IsNumber(v) || !std::isfinite(v->valuedouble) || v->valuedouble<0 ||
        v->valuedouble>2147483647 || floor(v->valuedouble)!=v->valuedouble) return -1;
    return int64_t(v->valuedouble);
}
static const char* names[]={"idle","cpu_load","wifi_connect","network_probe","wifi_stop","bme_measure"};
static constexpr int actionCount=sizeof(names)/sizeof(*names);
static_assert(actionCount==int(Action::bmeMeasure)+1);
static bool uuid(const char* s) {
    if (strlen(s)!=36) return false;
    for (int i=0;i<36;++i) {
        if (i==8 || i==13 || i==18 || i==23) { if (s[i]!='-') return false; }
        else if (!strchr("0123456789abcdef",s[i])) return false;
    }
    return true;
}
bool init() {
    if (nvs_open_from_partition("records","experiment_v2",NVS_READWRITE,&handle)!=ESP_OK) return false;
    size_t reportSize=sizeof(uploadReport);
    if (nvs_get_blob(handle,"upload_diag",&uploadReport,&reportSize)!=ESP_OK || reportSize!=sizeof(uploadReport) ||
        uploadReport.format!=1 || !uploadReport.sequence || uploadReport.sequence>2147483647 ||
        uploadReport.id[36] || !uuid(uploadReport.id) || uploadReport.reason>=UploadReason::Count ||
        (uploadReport.batteryMv!=-1 && (uploadReport.batteryMv<2000 || uploadReport.batteryMv>4500)) ||
        uploadReport.wifiMs< -1 || uploadReport.wifiMs>30000 || uploadReport.elapsedMs< -1 || uploadReport.elapsedMs>31000 ||
        uploadReport.httpAttempts>immediateUploadChunks || uploadReport.confirmedSamples>maxSamples) uploadReport={};
    size_t size=sizeof(state);
    auto result=nvs_get_blob(handle,"state",&state,&size);
    if (result==ESP_ERR_NVS_NOT_FOUND) { state={}; ready=true; return true; }
    if (result!=ESP_OK || size!=sizeof(state) || state.format!=1 || state.sequence>2147483647 || state.phase>Phase::result ||
        state.sampleCount>maxSamples || state.cursor>state.sampleCount || state.attempts>maxUploadAttempts ||
        state.id[36] || state.firmware[31] || state.outcome[31] ||
        (state.phase!=Phase::empty && (!uuid(state.id) || !validSteps(state.steps,state.stepCount,state.interval)))) return false;
    ready=true;
    if (state.phase==Phase::running) {
        // Only the durable start marker survived: RAM samples cannot be recovered.
        state.phase=Phase::result; state.sampleCount=0;
        strlcpy(state.outcome,"interrupted",sizeof(state.outcome));
        ready=save();
    }
    return ready;
}
bool busy() { return ready && state.phase==Phase::pending; }
void status(cJSON* root) {
    auto obj=cJSON_AddObjectToObject(root,"experiment");
    cJSON_AddNumberToObject(obj,"schema_version",1);
    cJSON_AddBoolToObject(obj,"available",ready);
    cJSON_AddNumberToObject(obj,"sequence",state.sequence);
    const char* phases[]={"idle","queued","running","result_pending"};
    cJSON_AddStringToObject(obj,"state",ready ? phases[unsigned(state.phase)] : "storage_error");
    cJSON_AddStringToObject(obj,"id",state.id);
    cJSON_AddStringToObject(obj,"outcome",state.outcome);
    cJSON_AddNumberToObject(obj,"samples",state.sampleCount);
    cJSON_AddNumberToObject(obj,"upload_attempts",state.attempts);
    if (uploadReport.sequence) {
        auto diag=cJSON_AddObjectToObject(obj,"immediate_upload");
        cJSON_AddNumberToObject(diag,"schema_version",uploadReport.format);
        cJSON_AddStringToObject(diag,"id",uploadReport.id);
        cJSON_AddNumberToObject(diag,"sequence",uploadReport.sequence);
        cJSON_AddStringToObject(diag,"reason",uploadReasons[unsigned(uploadReport.reason)]);
        const auto metric=[&](const char* key,int value) {
            if (value<0) cJSON_AddNullToObject(diag,key); else cJSON_AddNumberToObject(diag,key,value);
        };
        metric("battery_mv",uploadReport.batteryMv);
        metric("wifi_ms",uploadReport.wifiMs);
        metric("elapsed_ms",uploadReport.elapsedMs);
        cJSON_AddNumberToObject(diag,"http_attempts",uploadReport.httpAttempts);
        cJSON_AddNumberToObject(diag,"confirmed_samples",uploadReport.confirmedSamples);
    }
}
bool accept(const cJSON* control) {
    if (!ready) return false;
    // Explicit administrator discard is the only way to replace unacknowledged results.
    if (number(control,"discard_experiment_sequence")==state.sequence && state.phase!=Phase::empty) {
        auto old=state.phase; state.phase=Phase::empty;
        if (!save()) { state.phase=old; ready=false; return false; }
    }
    auto input=cJSON_GetObjectItemCaseSensitive(control,"experiment");
    if (!cJSON_IsObject(input) || state.phase!=Phase::empty || emergencyMode() || !validClock() || queued()>8) return false;
    if (cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(control,"maintenance")) ||
        cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(control,"update"))) return false;
    const auto seq=number(input,"sequence"), expires=number(input,"expires_epoch");
    auto steps=cJSON_GetObjectItemCaseSensitive(input,"steps");
    const auto count=cJSON_GetArraySize(steps);
    const auto interval=number(input,"sample_interval_ms");
    if (number(input,"schema_version")!=1 || seq<=state.sequence || !uuid(str(input,"id")) ||
        expires<=time(nullptr) || expires>time(nullptr)+86400 || !cJSON_IsArray(steps) || count<1 || count>maxSteps) return false;
    Step parsed[maxSteps]{};
    for (int i=0;i<count;++i) {
        auto step=cJSON_GetArrayItem(steps,i); int action=0;
        for (;action<actionCount && strcmp(str(step,"action"),names[action]);++action) {}
        if (action==actionCount) return false;
        parsed[i]={Action(action),uint32_t(number(step,"duration_ms"))};
    }
    if (!validSteps(parsed,count,interval)) return false;
    // Reserve ample NVS headroom for two blobs + ordinary readings. Never erase the observation queue.
    nvs_stats_t stats{};
    if (nvs_get_stats("records",&stats)!=ESP_OK || stats.free_entries<800) return false;
    State next{}; next.sequence=seq; next.expires=expires; next.phase=Phase::pending;
    next.interval=interval; next.stepCount=count;
    strlcpy(next.id,str(input,"id"),sizeof(next.id));
    memcpy(next.steps,parsed,sizeof(parsed)); state=next;
    if (!save()) { ready=false; return false; }
    return true;
}

struct Sampling {
    std::atomic<bool> stop{false}, done{false};
    std::atomic<int> abort{0}; // 1 voltage, 2 ADC unavailable, 3 capacity
    std::atomic<unsigned> step{0};
    std::atomic<uint16_t> sensorPhase{0};
    int64_t start=0;
    float safetyVoltage=NAN;
};
static void sampleTask(void* arg) {
    auto& run=*static_cast<Sampling*>(arg);
    VoltageGuard guard;
    int64_t next=esp_timer_get_time();
    while (!run.stop.load() && !run.abort.load()) {
        if (state.sampleCount>=maxSamples) { run.abort=3; break; }
        auto& s=state.samples[state.sampleCount++];
        s.us=uint32_t(esp_timer_get_time()-run.start); s.step=run.step.load();
        s.reserved=run.sensorPhase.load();
        int raw,mv; s.valid=batterySample(raw,mv); s.raw=raw; s.mv=mv;
        run.abort=guard.observe(s.valid,mv);
        run.safetyVoltage=guard.meanMv<0 ? NAN : guard.meanMv/1000.0f;
        next+=state.interval*1000;
        // Do not emit catch-up bursts after a delayed conversion. Record actual time instead.
        if (next<=esp_timer_get_time()) next=esp_timer_get_time()+state.interval*1000;
        while (!run.stop.load() && !run.abort.load() && esp_timer_get_time()<next)
            vTaskDelay(1);
    }
    // A blocked network operation must not keep a failing battery under load.
    // If orderly teardown/save cannot finish, the durable marker reports interrupted next wake.
    if (run.abort.load()) setHardDeadline(3);
    run.done=true;
    vTaskDelete(nullptr);
}
static bool runBme(Sampling& run, int64_t end) {
    // Repeats are phase-shifted relative to the 20ms ADC cadence. This only calls
    // the I2C sensor path, never the ordinary Record/ADC/storage/telemetry path.
    while (!run.abort.load() && monotonicMs()+bmeMinRemainingMs<end) {
        const auto next=monotonicMs()+bmeRepeatMs;
        EnvironmentReading reading{};
        if (!readEnvironment(reading, [](uint16_t phase,void* context) {
            static_cast<Sampling*>(context)->sensorPhase.store(phase);
        }, &run)) return false;
        while (!run.abort.load() && monotonicMs()<std::min(next,end)) vTaskDelay(1);
    }
    return true;
}
static void finish(const char* outcome) {
    strlcpy(state.outcome,outcome,sizeof(state.outcome)); state.phase=Phase::result;
    if (!save()) { ready=false; ESP_LOGE("experiment","Result save failed; durable start marker retained"); }
}
bool runPending() {
    if (!busy()) return false;
    // A new OTA image must pass its ordinary local self-test before it can run experiments.
    esp_ota_img_states_t imageState;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(),&imageState)==ESP_OK && imageState==ESP_OTA_IMG_PENDING_VERIFY) return false;
    strlcpy(state.firmware,esp_app_get_description()->version,sizeof(state.firmware));
    if (!validClock()) { finish("clock_unavailable"); return false; }
    if (time(nullptr)>=state.expires) { finish("expired"); return false; }
    const float voltage=batteryAverage();
    if (!observeBattery(voltage,false)) return false;
    if (emergencyMode() || policy::millivolts(voltage)<startMv) { finish("battery_not_ready"); return false; }
    if (queued()>8) { finish("backlog_pending"); return false; }
    state.phase=Phase::running; state.startedAt=time(nullptr);
    if (!save()) { ready=false; return false; } // No actions before durable at-most-once marker.
    int duration=0; for (unsigned i=0;i<state.stepCount;++i) duration+=state.steps[i].durationMs;
    setHardDeadline((duration+999)/1000+10);
    Sampling run; run.start=esp_timer_get_time();
    if (xTaskCreate(sampleTask,"voltage_samples",3072,&run,5,nullptr)!=pdPASS) { finish("sampler_failed"); return true; }
    bool ok=true, wifi=false;
    const char* outcome="completed";
    for (unsigned i=0;i<state.stepCount && !run.abort.load();++i) {
        run.step=i;
        state.stepStartUs[i]=esp_timer_get_time()-run.start;
        const auto step=state.steps[i]; auto end=monotonicMs()+step.durationMs;
        if (step.action==Action::wifiConnect) { wifi=connectWifi(end,1); ok=wifi; }
        else if (step.action==Action::wifiStop) { stopWifi(); wifi=false; }
        else if (step.action==Action::probe) {
            int code=0; auto body=cJSON_CreateObject(); cJSON_AddStringToObject(body,"experiment_id",state.id);
            auto response=postJson("/v1/station/experiment/probe",body,end,code);
            ok=wifi && code==200 && !strcmp(str(response,"experiment_id"),state.id);
            cJSON_Delete(response); cJSON_Delete(body);
        }
        else if (step.action==Action::bmeMeasure) ok=runBme(run,end);
        while (ok && !run.abort.load() && monotonicMs()<end) {
            if (step.action==Action::cpu) {
                // Synthetic integer work, not a calibrated wattage or a forced clock change.
                volatile uint32_t value=1;
                for (unsigned j=0;j<20000;++j) value=value*1664525u+1013904223u;
            }
            vTaskDelay(1); // Keep sampler, watchdog and deadline guard schedulable.
        }
        state.stepEndUs[i]=esp_timer_get_time()-run.start;
        state.stepOk[i]=ok && !run.abort.load();
        if (!ok) { outcome=step.action==Action::bmeMeasure ? "sensor_failed" : "network_failed"; break; }
    }
    run.stop=true;
    while (!run.done.load()) vTaskDelay(1);
    stopWifi();
    if (run.abort.load()) {
        outcome=run.abort==1 ? "low_voltage" : run.abort==2 ? "adc_unavailable" : "sample_limit";
        if (run.abort!=3) observeBattery(run.safetyVoltage,false);
    }
    // No result upload, BME measurement or application NVS writes in the sampling/recovery window.
    // Radio initialization/PHY calibration remains SDK-controlled and is part of the measured load.
    finish(outcome);
    ESP_LOGI("experiment","Run finished: %s, %lu samples",outcome,(unsigned long)state.sampleCount);
    return true;
}

static UploadReason immediateVoltageCheck() {
    const auto voltage = batteryAverage();
    uploadReport.batteryMv = policy::millivolts(voltage);
    if (!observeBattery(voltage,false)) return UploadReason::StorageError;
    if (uploadReport.batteryMv<0) return UploadReason::BatteryUnavailable;
    if (emergencyMode()) return UploadReason::Emergency;
    return uploadReport.batteryMv<startMv ? UploadReason::BatteryLow : UploadReason::Completed;
}

static UploadReason uploadChunks(int64_t deadline, int maxChunks, bool checkBattery) {
    if (!ready) return UploadReason::StorageError;
    if (state.phase!=Phase::result) return UploadReason::ExperimentNotCompleted;
    if (emergencyMode()) return UploadReason::Emergency;
    if (!validClock()) return UploadReason::ClockUnavailable;
    if (state.attempts>=maxUploadAttempts) return UploadReason::AttemptLimit;
    if (time(nullptr)<state.nextUpload) return UploadReason::HttpFailed;
    for (int sent=0;sent<maxChunks && monotonicMs()+2000<deadline && state.phase==Phase::result && state.attempts<maxUploadAttempts;++sent) {
        if (checkBattery) {
            const auto power=immediateVoltageCheck();
            if (power!=UploadReason::Completed) return power;
        }
        // Persist attempt before HTTP; a reset consumes an attempt and preserves the backoff.
        ++state.attempts; state.nextUpload=time(nullptr)+3600;
        if (!save()) { ready=false; return UploadReason::StorageError; }
        auto body=cJSON_CreateObject();
        cJSON_AddNumberToObject(body,"schema_version",1);
        cJSON_AddStringToObject(body,"id",state.id); cJSON_AddNumberToObject(body,"sequence",state.sequence);
        cJSON_AddStringToObject(body,"firmware_version",state.firmware);
        cJSON_AddStringToObject(body,"outcome",state.outcome);
        cJSON_AddNumberToObject(body,"started_epoch",state.startedAt);
        cJSON_AddNumberToObject(body,"sample_interval_ms",state.interval);
        cJSON_AddNumberToObject(body,"total_samples",state.sampleCount);
        cJSON_AddNumberToObject(body,"offset",state.cursor);
        auto steps=cJSON_AddArrayToObject(body,"step_results");
        for (unsigned i=0;i<state.stepCount;++i) {
            auto row=cJSON_CreateArray(); cJSON_AddItemToArray(steps,row);
            cJSON_AddItemToArray(row,cJSON_CreateNumber(state.stepStartUs[i]));
            cJSON_AddItemToArray(row,cJSON_CreateNumber(state.stepEndUs[i]));
            cJSON_AddItemToArray(row,cJSON_CreateBool(state.stepOk[i]));
        }
        auto samples=cJSON_AddArrayToObject(body,"samples");
        unsigned end=std::min<unsigned>(state.sampleCount,state.cursor+chunkSize);
        for (unsigned i=state.cursor;i<end;++i) {
            const auto s=state.samples[i]; auto row=cJSON_CreateArray(); cJSON_AddItemToArray(samples,row);
            cJSON_AddItemToArray(row,cJSON_CreateNumber(s.us)); cJSON_AddItemToArray(row,cJSON_CreateNumber(s.step));
            cJSON_AddItemToArray(row,s.raw>=0 ? cJSON_CreateNumber(s.raw) : cJSON_CreateNull());
            cJSON_AddItemToArray(row,s.valid ? cJSON_CreateNumber(s.mv) : cJSON_CreateNull());
            // Fifth value is present only on BME samples. Reuse the existing reserved
            // word to keep the flash record layout and older experiment traces intact.
            if (state.steps[s.step].action==Action::bmeMeasure) cJSON_AddItemToArray(row,cJSON_CreateNumber(s.reserved));
        }
        int code; auto response=postJson("/v1/station/experiment/results",body,deadline,code); cJSON_Delete(body);
        const auto next=number(response,"next_offset");
        const bool complete=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response,"complete"));
        // Server may rewind after a restore: never discard a trace based only on its last chunk.
        const bool ack=code==200 && !strcmp(str(response,"id"),state.id) && next>=0 && next<=state.sampleCount &&
            (next==state.sampleCount ? complete : next%chunkSize==0);
        cJSON_Delete(response);
        if (!ack) return UploadReason::HttpFailed;
        state.cursor=next; state.nextUpload=0;
        if (next==state.sampleCount) state.phase=Phase::empty;
        if (!save()) { ready=false; return UploadReason::StorageError; }
    }
    if (state.phase==Phase::empty) return UploadReason::Completed;
    return state.attempts>=maxUploadAttempts ? UploadReason::AttemptLimit : UploadReason::Deadline;
}

static UploadReason tryImmediateUpload() {
    // Only a normal, durably saved result can extend the wake. In particular, do not
    // override the sampler's short abort deadline or reconnect after a failed test.
    if (!ready) return UploadReason::StorageError;
    if (strcmp(state.outcome,"completed")) return UploadReason::ExperimentNotCompleted;
    if (!validClock()) return UploadReason::ClockUnavailable;
    if (emergencyMode()) return UploadReason::Emergency;
    const auto power=immediateVoltageCheck();
    if (power!=UploadReason::Completed) return power;
    const auto now = time(nullptr);
    const auto window = immediateWindowSeconds(policy::nextSlot(now,activePeriod())-now);
    if (!window) return UploadReason::WindowTooShort;
    const auto deadline=monotonicMs() + (window-1)*1000;
    setHardDeadline(window);
    saveUploadReport(); // If a watchdog/power cut wins, the next boot can distinguish interruption.
    const auto wifiStart=monotonicMs();
    if (wifiStart+2000>=deadline) return UploadReason::Deadline;
    WifiConnectFailure failure;
    const bool connected=connectWifi(std::min<int64_t>(deadline-2000,wifiStart+immediateConnectMs),1,&failure);
    uploadReport.wifiMs=std::min<int64_t>(30000,monotonicMs()-wifiStart);
    const auto reason=connected ? uploadChunks(deadline,immediateUploadChunks,true)
        : failure==WifiConnectFailure::Start ? UploadReason::WifiStartFailed
        : failure==WifiConnectFailure::Connect ? UploadReason::WifiConnectFailed
        : failure==WifiConnectFailure::IpTimeout ? UploadReason::WifiIpTimeout : UploadReason::WifiFailed;
    stopWifi();
    return reason;
}

void uploadAfterRun() {
    if (state.phase!=Phase::result) return;
    const auto start=monotonicMs();
    const auto attempts=state.attempts;
    uploadReport={};
    uploadReport.sequence=state.sequence;
    strlcpy(uploadReport.id,state.id,sizeof(uploadReport.id));
    uploadReport.reason=tryImmediateUpload();
    uploadReport.elapsedMs=std::min<int64_t>(31000,monotonicMs()-start);
    uploadReport.httpAttempts=state.attempts-attempts;
    uploadReport.confirmedSamples=state.cursor;
    saveUploadReport();
    ESP_LOGI("experiment","Immediate upload: %s, %lu confirmations, %ld ms",
        uploadReasons[unsigned(uploadReport.reason)],(unsigned long)uploadReport.confirmedSamples,(long)uploadReport.elapsedMs);
}

void upload(int64_t deadline) {
    // On later ordinary wakes, observation upload keeps priority and this smaller budget remains.
    uploadChunks(deadline,ordinaryUploadChunks,false);
}
}
