#ifndef TRANSACTION_H
#define TRANSACTION_H

#include <string>

struct AppState; // forward declaration — full definition in app_state.h

class Transaction {
public:
    std::string machine_id;
    std::string vendorId;
    std::string voucherId;
    double amount;
    std::string slot;
    std::string dateCreated;
};

bool saveClassToJsonFileGeneric(const Transaction &obj, const std::string &filePath);
void processSaving(AppState &state, int slot, double amount, std::string voucherId = "", int postfix = 0);

#endif // TRANSACTION_H
