#pragma once
#include <stdint.h>
#include "cJSON.h"

// No scripts, URLs, register writes or arbitrary code accepted from a recipe.
namespace experiment {
bool init();
void status(cJSON* root);
bool accept(const cJSON* control);
bool busy();
// Called before the first normal measurement / Wi-Fi on a wake. True => experiment wake; skip regular observation.
bool runPending();
// Called only after runPending() used this wake, before returning to sleep.
void uploadAfterRun();
void upload(int64_t deadline);
}
