#pragma once
#include <stdint.h>
#include "cJSON.h"

// No scripts, URLs, register writes or arbitrary code accepted from a recipe.
namespace experiment {
bool init();
void status(cJSON* root);
bool accept(const cJSON* control);
bool busy();
// Called before the first normal measurement / Wi-Fi on a wake. True => sleep now.
bool runPending();
void upload(int64_t deadline);
}
