#ifndef PUMP_CONTROL_H
#define PUMP_CONTROL_H

#include "app_state.h"

// Initialise GPIO, ISRs, load config.env into state, create transaction dir.
void pump_setup(AppState &state);

// One iteration of the pump state machine — call every loop tick.
void pump_loop(AppState &state);

// Turn all pumps OFF (call before exit).
void pump_shutdown();

#endif // PUMP_CONTROL_H
