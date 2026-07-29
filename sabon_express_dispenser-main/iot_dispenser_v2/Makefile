# Define the name of your executable
TARGET = main_gui

# Source files
SRCS = main.cpp

# --- Platform-specific Linker Flags ---
# Default flags for Linux/macOS (for std::thread::sleep_for)
LDFLAGS_UNIX = -pthread

# Flags for Windows with MinGW/MSYS2 (for Winsock and static linking)
LDFLAGS_WINDOWS = -lws2_32 -static-libgcc -static-libstdc++

# Get FLTK compile flags (includes, definitions)
FLTK_CXXFLAGS = $(shell fltk-config --cxxflags)

# Get FLTK linker flags (libraries, library paths)
# Using --use-images here, as you mentioned
FLTK_LDFLAGS = $(shell fltk-config --ldflags --use-images)

# Standard C++ compiler
CXX = g++

# Default target: build the application
all: $(TARGET)

$(TARGET): $(SRCS)
	@echo "Compiling $(TARGET)..."
	$(CXX) $(FLTK_CXXFLAGS) $(LDFLAGS_UNIX)  $(SRCS) -o $(TARGET) $(FLTK_LDFLAGS)
	@echo "Build complete."

# Clean up compiled files
clean:
	@echo "Cleaning up..."
	@rm -f $(TARGET) *.o
	@echo "Clean complete."

.PHONY: all clean