CC = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -Wno-unused-parameter -g -Iincludes

# Detect OS — affects main binary only
ifeq ($(OS),Windows_NT)
    CXXFLAGS    += -Imock
    LDFLAGS      = -lws2_32
    MOCK_OBJS    = mock/wiringPi.o
    EXE          = main.exe
    TEST_RUNNER  = tests/test_runner.exe
    TEST_LDFLAGS = -lws2_32
else
    LDFLAGS      = -lwiringPi
    MOCK_OBJS    =
    EXE          = main
    TEST_RUNNER  = tests/test_runner
    TEST_LDFLAGS =
endif

.PHONY: all clean test run

# -----------------------------------------------------------------------
# Main binary
# -----------------------------------------------------------------------

OBJS = main.o src/pump_control.o src/transaction.o \
       src/utils.o src/hardware_config.o \
       src/socket_server.o $(MOCK_OBJS)

all: $(EXE)

$(EXE): $(OBJS)
	$(CC) -o $(EXE) $(OBJS) $(LDFLAGS)

%.o: %.cpp
	$(CC) $(CXXFLAGS) -c $< -o $@

mock/%.o: mock/%.cpp
	$(CC) $(CXXFLAGS) -c $< -o $@

run: $(EXE)
	./$(EXE)

clean:
	rm -f *.o src/*.o mock/*.o tests/*.o tests/obj/*.o \
	      tests/test_runner tests/test_runner.exe \
	      $(EXE) *.gch includes/*.gch src/*.gch
	-rmdir tests/obj 2>/dev/null || true

# -----------------------------------------------------------------------
# Test target — works on BOTH Linux (Pi) and Windows
#
# Module objects are compiled into tests/obj/ with -Imock so the test
# build never depends on real wiringPi hardware or root permissions.
# The main binary's src/*.o are left untouched.
# -----------------------------------------------------------------------

# Test build always uses mock, regardless of host OS
TEST_CXXFLAGS = -std=c++17 -Wall -Wextra -Wno-unused-parameter -g -Iincludes -Imock

TEST_OBJS = tests/run_tests.o \
            tests/test_utils.o \
            tests/test_socket_cmd.o tests/test_mock.o tests/test_hardware.o \
            tests/test_transaction_json.o tests/test_app_state.o \
            tests/test_product_config.o tests/test_transaction_write.o \
            tests/test_module_linkage.o tests/test_input_validation.o tests/test_config_loading.o \
            tests/test_armed_state.o tests/test_logging.o \
            tests/test_socket_integration.o

# Source modules compiled with mock support into tests/obj/
# (separate from src/*.o used by the main binary)
TEST_MODULE_OBJS = tests/obj/pump_control.o tests/obj/utils.o \
                   tests/obj/hardware_config.o \
                   tests/obj/socket_server.o tests/obj/transaction.o \
                   mock/wiringPi.o

tests/obj/%.o: src/%.cpp
	@mkdir -p tests/obj
	$(CC) $(TEST_CXXFLAGS) -c $< -o $@

tests/%.o: tests/%.cpp
	$(CC) $(TEST_CXXFLAGS) -Itests -c $< -o $@

mock/wiringPi.o: mock/wiringPi.cpp
	$(CC) $(TEST_CXXFLAGS) -c $< -o $@

test: $(TEST_OBJS) $(TEST_MODULE_OBJS)
	$(CC) -o $(TEST_RUNNER) $(TEST_OBJS) $(TEST_MODULE_OBJS) $(TEST_LDFLAGS)
	./$(TEST_RUNNER)
