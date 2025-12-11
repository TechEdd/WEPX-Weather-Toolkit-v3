import json
import numpy as np

# Load the original data
input_file = "RETOP.txt"
output_file = "RETOP_.txt"

with open(input_file, "r") as f:
    data = json.load(f)

# Determine step size to get approximately 10 values
num_values = 10
indices = np.linspace(0, len(data) - 1, num_values, dtype=int)

# Select the values
reduced_data = [data[i] for i in indices]

# Save to a new file
with open(output_file, "w") as f:
    json.dump(reduced_data, f, indent=2)

print(f"Reduced data saved to {output_file}")
