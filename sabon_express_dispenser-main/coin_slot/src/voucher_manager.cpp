#include "voucher_manager.h"
#include <stdexcept>

void enqueueVoucher(std::vector<unusedVoucher> &vec, const unusedVoucher &value)
{
  vec.push_back(value);
}

unusedVoucher dequeueVoucher(std::vector<unusedVoucher> &vec)
{
  if (vec.empty())
    throw std::runtime_error("Attempted to dequeue from an empty queue.");
  unusedVoucher front = vec.front();
  vec.erase(vec.begin());
  return front;
}

int getTotalVoucherAmount(const std::vector<unusedVoucher> &vouchers)
{
  int total = 0;
  for (const auto &v : vouchers) total += v.amount;
  return total;
}

std::vector<unusedVoucher> getAvailableVoucher(const std::vector<unusedVoucher> &available, double targetAmount)
{
  std::vector<unusedVoucher> selected;
  double accumulated = 0;
  for (const auto &v : available)
  {
    selected.push_back(v);
    accumulated += v.amount;
    if (accumulated >= targetAmount) break;
  }
  return selected;
}
