import qrcode
import json
import datetime
import uuid

def generate_qr_code_with_json_template(output_filename="qrcode_data.png"):
    """
    Generates a QR code containing a JSON string with a predefined template.

    The JSON template includes fields for:
    - uuid: A universally unique identifier.
    - vendorId: An ID for the vendor (example, can be filled dynamically).
    - machineId: An ID for the machine (example, can be filled dynamically).
    - change: A field for any specific change or status (example).
    - dateGenerated: The date and time the QR code was generated.

    Args:
        output_filename (str): The name of the file to save the QR code image.
                               Defaults to "qrcode_data.png".
    """
    # 1. Define the JSON template as a Python dictionary
    # In a real application, 'uuid', 'vendorId', 'machineId', and 'change'
    # would likely be populated with actual data from your system.
    # For this example, 'uuid' is auto-generated, and others are placeholders.
    data_template = {
        "uuid": str(uuid.uuid4()), # Generates a unique UUID
        "vendorId": "82668cda-407a-11f0-bf83-309c23cb09d6",  # Placeholder: Replace with actual vendor ID
        "machineId": 20, # Placeholder: Replace with actual machine ID
        "change": 20, # Placeholder: Describe the change/status
        "dateGenerated": datetime.datetime.now().isoformat() # Current timestamp
    }

    # 2. Convert the Python dictionary to a JSON string
    # `json.dumps` serializes the dictionary to a JSON formatted string.
    # `indent=2` makes the JSON string readable, but for QR codes, a compact
    # string (without indent) is often preferred to reduce QR code complexity.
    # We'll use a compact version for the QR code data to ensure better readability
    # by scanners, but print the pretty version for user understanding.
    json_data_for_qr = json.dumps(data_template, separators=(',', ':'))
    json_data_pretty_print = json.dumps(data_template, indent=2)

    print(f"Generating QR code with the following JSON data:\n{json_data_pretty_print}")

    # 3. Generate the QR code
    # `qrcode.QRCode` creates an instance of a QR code generator.
    # `version`: Controls the size and data capacity of the QR code. None means auto.
    # `error_correction`: L, M, Q, H (Low, Medium, Quartile, High). Higher means more
    #                     redundancy (can be scanned even if damaged) but larger QR code.
    # `box_size`: How many pixels each box of the QR code is.
    # `border`: How many boxes thick the white border around the QR code is.
    qr = qrcode.QRCode(
        version=1, # Adjust version or set to None for auto-sizing based on data length
        error_correction=qrcode.constants.ERROR_CORRECT_L, # Low error correction
        box_size=10,
        border=4,
    )

    # Add the JSON string data to the QR code
    qr.add_data(json_data_for_qr)
    qr.make(fit=True) # `fit=True` ensures the code fits all the data

    # 4. Create the QR code image
    # `make_image` creates an image object.
    # `fill_color`: Color of the QR code modules (black by default).
    # `back_color`: Color of the background (white by default).
    img = qr.make_image(fill_color="black", back_color="white")

    # 5. Save the QR code image to a file
    try:
        img.save(output_filename)
        print(f"QR code successfully generated and saved as '{output_filename}'")
    except Exception as e:
        print(f"Error saving QR code image: {e}")

if __name__ == "__main__":
    # Call the function to generate the QR code
    generate_qr_code_with_json_template()
