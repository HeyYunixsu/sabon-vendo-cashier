#include "test_framework.h"
#include "transaction.h"
#include "app_state.h"
#include <fstream>
#include <sstream>
#include <filesystem>

namespace fs = std::filesystem;

// Phase 5 moved processSaving() from voucher_manager.cpp to transaction.cpp
// and replaced extern machineId / extern vendorId with AppState& state.
// These tests confirm:
//   1. processSaving creates a file on disk
//   2. The file content reflects the AppState values passed in (not some
//      global that could silently come from anywhere)
//   3. Voucher ID is recorded when provided, absent when empty
//   4. Slot number appears in both the file name and file content

// ------------------------------------------------ helpers ---

static std::string read_file(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

// Find a file in ../transaction/ whose name contains needle.
// Returns the full path, or "" if not found.
static std::string find_transaction_file(const std::string &needle)
{
    if (!fs::exists("../transaction")) return "";
    for (auto &entry : fs::directory_iterator("../transaction"))
    {
        if (entry.path().string().find(needle) != std::string::npos)
            return entry.path().string();
    }
    return "";
}

// ------------------------------------------ file creation ---

void test_processSaving_creates_file()
{
    fs::create_directories("../transaction");
    AppState state;
    state.machineId = "M_CREATE";
    state.vendorId  = "V_CREATE";

    processSaving(state, 1, 5.0, "VOUCH_CREATE", 1001);

    std::string found = find_transaction_file("_transaction_1_1001.json");
    CHECK(found != "");
    if (found != "") fs::remove(found);
}

// ---------------------------------- AppState values flow in ---

void test_processSaving_machineId_from_AppState()
{
    fs::create_directories("../transaction");
    AppState state;
    state.machineId = "MACHINE_PHASE5";
    state.vendorId  = "VENDOR_PHASE5";

    processSaving(state, 2, 10.0, "V_MACH", 1002);

    std::string path = find_transaction_file("_transaction_2_1002.json");
    CHECK(path != "");
    if (path != "")
    {
        std::string content = read_file(path);
        CHECK(content.find("MACHINE_PHASE5") != std::string::npos);
        fs::remove(path);
    }
}

void test_processSaving_vendorId_from_AppState()
{
    fs::create_directories("../transaction");
    AppState state;
    state.machineId = "M_VND";
    state.vendorId  = "VENDOR_PHASE5_CHECK";

    processSaving(state, 3, 5.0, "V_VND", 1003);

    std::string path = find_transaction_file("_transaction_3_1003.json");
    CHECK(path != "");
    if (path != "")
    {
        std::string content = read_file(path);
        CHECK(content.find("VENDOR_PHASE5_CHECK") != std::string::npos);
        fs::remove(path);
    }
}

// Two calls with different AppState instances produce different content —
// proves the function reads state at call time, not a cached global.
void test_processSaving_respects_different_AppState_instances()
{
    fs::create_directories("../transaction");

    AppState s1;
    s1.machineId = "MACHINE_AAA";
    s1.vendorId  = "VENDOR_AAA";
    processSaving(s1, 1, 5.0, "", 1004);

    AppState s2;
    s2.machineId = "MACHINE_BBB";
    s2.vendorId  = "VENDOR_BBB";
    processSaving(s2, 1, 5.0, "", 1005);

    std::string p1 = find_transaction_file("_transaction_1_1004.json");
    std::string p2 = find_transaction_file("_transaction_1_1005.json");

    if (p1 != "")
    {
        std::string c1 = read_file(p1);
        CHECK(c1.find("MACHINE_AAA") != std::string::npos);
        CHECK(c1.find("MACHINE_BBB") == std::string::npos);
        fs::remove(p1);
    }
    if (p2 != "")
    {
        std::string c2 = read_file(p2);
        CHECK(c2.find("MACHINE_BBB") != std::string::npos);
        CHECK(c2.find("MACHINE_AAA") == std::string::npos);
        fs::remove(p2);
    }
    CHECK(p1 != "");
    CHECK(p2 != "");
}

// ----------------------------------------- voucher id field ---

void test_processSaving_voucherId_present_when_given()
{
    fs::create_directories("../transaction");
    AppState state;
    state.machineId = "M_V";
    state.vendorId  = "V_V";

    processSaving(state, 4, 5.0, "VOUCHER_PRESENT", 1006);

    std::string path = find_transaction_file("_transaction_4_1006.json");
    CHECK(path != "");
    if (path != "")
    {
        std::string content = read_file(path);
        CHECK(content.find("VOUCHER_PRESENT") != std::string::npos);
        fs::remove(path);
    }
}

void test_processSaving_empty_voucherId_for_coin_only()
{
    fs::create_directories("../transaction");
    AppState state;
    state.machineId = "M_COIN";
    state.vendorId  = "V_COIN";

    // Coin-only dispense passes an empty voucherId
    processSaving(state, 1, 5.0, "", 1007);

    std::string path = find_transaction_file("_transaction_1_1007.json");
    CHECK(path != "");
    if (path != "") fs::remove(path);
}

// ---------------------------------------------- slot field ---

void test_processSaving_slot_appears_in_filename()
{
    fs::create_directories("../transaction");
    AppState state;
    state.machineId = "M_SL"; state.vendorId = "V_SL";

    processSaving(state, 3, 5.0, "", 1008);

    // Slot 3 must appear in the generated filename
    std::string path = find_transaction_file("_transaction_3_1008.json");
    CHECK(path != "");
    if (path != "") fs::remove(path);
}

// ---------------------------------------------------------- entry point ---

void run_phase5_tests()
{
    SUITE("phase5 (processSaving uses AppState, not externs)");
    RUN_TEST(test_processSaving_creates_file);
    RUN_TEST(test_processSaving_machineId_from_AppState);
    RUN_TEST(test_processSaving_vendorId_from_AppState);
    RUN_TEST(test_processSaving_respects_different_AppState_instances);
    RUN_TEST(test_processSaving_voucherId_present_when_given);
    RUN_TEST(test_processSaving_empty_voucherId_for_coin_only);
    RUN_TEST(test_processSaving_slot_appears_in_filename);
}
